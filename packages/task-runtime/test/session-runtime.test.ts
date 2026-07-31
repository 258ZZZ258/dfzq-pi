import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

function toolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "Echo the input back.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id: string, params: { text: string }) => ({ output: params.text, content: params.text }),
		} as never,
	]);
	return registry;
}

function spec(limits: RuntimeSpec["limits"]): RuntimeSpec {
	return { id: "demo", model: { role: "main" }, toolset: "demo", tools: ["echo"], limits };
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

/** Polls `predicate` until it's true, sleeping `stepMs` between checks. Throws after `timeoutMs`
 *  so a stuck condition fails fast with a clear message instead of hanging until vitest's
 *  own test timeout. */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000, stepMs = 1): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

async function build(limits: RuntimeSpec["limits"], responses: unknown[], registry = createDefaultPluginRegistry()) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses(responses as never);
	const runtime = await createSessionRuntime({
		spec: spec(limits),
		profile,
		registry,
		toolsets: toolsets(),
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	});
	cleanups.push(runtime.dispose);
	return runtime;
}

describe("SessionRuntime", () => {
	it("returns a completed RunResult with usage and timing", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const result = await runtime.run("hello");
		expect(result.status).toBe("completed");
		expect(result.output).toContain("done");
		expect(result.runId).toMatch(/.+/);
		// RunResult carries specId alongside RuntimeEvent (final fix round, finding 4): the
		// runs table and the S3 pool's get(specId, sessionId?) both correlate on it, and it
		// must agree with the Runtime and with the event envelopes.
		expect(result.specId).toBe("demo");
		expect(result.specId).toBe(runtime.specId);
		expect(result.turns).toBeGreaterThanOrEqual(1);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.usage.total).toBeGreaterThanOrEqual(0);
	});

	it("accepts a caller-supplied runId", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const result = await runtime.run("hello", { runId: "run-42" });
		expect(result.runId).toBe("run-42");
	});

	it("reports limit_exceeded with limit=runTimeout when the run times out", async () => {
		const runtime = await build({ runTimeoutMs: 1 }, [
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve(fauxAssistantMessage("late")), 200);
				}),
		]);
		const result = await runtime.run("hello");
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("runTimeout");
	});

	it("emits enveloped events with monotonically increasing seq", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const seen: number[] = [];
		const unsubscribe = runtime.subscribe((event) => {
			expect(event.runId).toBeTruthy();
			expect(event.specId).toBe("demo");
			seen.push(event.seq);
		});
		await runtime.run("hello");
		unsubscribe();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("exposes a snapshot with the session id", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		expect(runtime.snapshot().sessionId).toBe(runtime.sessionId);
	});

	// Regression lock (fix round 1): the original `abort: async () => void session.abort()`
	// discarded the underlying promise instead of returning it. session.abort() awaits
	// waitForIdle() internally (agent-session.ts:1542-1546), so a caller doing
	// `await runtime.abort()` must only observe the session as stopped, not mid-flight.
	it("abort() resolves only after the session has actually stopped, and reports status=aborted", async () => {
		const runtime = await build({ maxTurns: 5 }, [
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve(fauxAssistantMessage("late")), 150);
				}),
		]);
		const runPromise = runtime.run("hello");
		// Wait for the run to genuinely be in flight before aborting -- otherwise abort() would
		// be a same-tick no-op and wouldn't exercise the "wait for real stop" guarantee.
		await waitUntil(() => !runtime.isIdle);

		await runtime.abort();
		expect(runtime.isIdle).toBe(true);

		const result = await runPromise;
		expect(result.status).toBe("aborted");
		expect(result.stopReason).toBe("aborted");
	});

	// Regression lock for the two `classify()` stopReason branches the review flagged as
	// untouched by any test (only "completed" and the tripped-limit path were covered).
	it("reports status=error when the assistant message stops with a non-retryable error", async () => {
		// "boom" matches none of pi's retryable-error text patterns (packages/ai/src/utils/retry.ts),
		// so this settles directly instead of looping through AgentSession's auto-retry.
		const runtime = await build({ maxTurns: 5 }, [
			fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "boom" }),
		]);
		const result = await runtime.run("hello");
		expect(result.status).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("boom");
	});

	// Regression lock (review Minor #1): run() must reset LimitState.turns/tripped on every
	// call. With maxTurns:2 and a single-turn reply each time, a leaked turn count from the
	// first run would push the second run's count to 2 and falsely trip maxTurns.
	it("resets LimitState between successive run() calls on the same runtime", async () => {
		const runtime = await build({ maxTurns: 2 }, [fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const first = await runtime.run("hello");
		expect(first.status).toBe("completed");
		expect(first.turns).toBe(1);

		const second = await runtime.run("hello again");
		expect(second.status).toBe("completed");
		expect(second.turns).toBe(1);
	});
});

describe("SessionRuntime - subscriber fan-out isolation", () => {
	// Regression lock (final fix round, finding 3): the fan-out loop ran listeners bare inside
	// pi's AgentSession._emit, which has no try/catch either -- so any throwing subscriber
	// unwound through the agent loop and broke the run. trajectory.ts's JSON.stringify(event)
	// is enough to trigger it on a cyclic payload.
	it("keeps delivering to the other listeners and completes the run when one listener throws", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		cleanups.push(async () => {
			errorSpy.mockRestore();
		});

		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const before: string[] = [];
		const after: string[] = [];
		let throwCount = 0;

		// Registered between two healthy listeners so the assertion covers both "listeners
		// added before the bad one still ran" and "fan-out did not stop at the bad one".
		runtime.subscribe((event) => before.push(event.type));
		runtime.subscribe(() => {
			throwCount += 1;
			throw new Error("subscriber boom");
		});
		runtime.subscribe((event) => after.push(event.type));

		const result = await runtime.run("hello");

		expect(result.status).toBe("completed");
		expect(result.output).toContain("done");
		expect(throwCount).toBeGreaterThan(0);
		expect(before.length).toBe(throwCount);
		expect(after).toEqual(before);
		expect(errorSpy).toHaveBeenCalled();
	});

	// The in-tree case that motivated this: a cyclic payload makes trajectory.ts's
	// JSON.stringify throw. Reproduce the shape directly against subscribe().
	it("survives a listener that throws on JSON.stringify of a cyclic structure", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		cleanups.push(async () => {
			errorSpy.mockRestore();
		});

		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const survivor: string[] = [];

		runtime.subscribe(() => {
			JSON.stringify(cyclic);
		});
		runtime.subscribe((event) => survivor.push(event.type));

		const result = await runtime.run("hello");
		expect(result.status).toBe("completed");
		expect(survivor.length).toBeGreaterThan(0);
	});
});

describe("SessionRuntime - shared PluginRegistry", () => {
	// Regression lock (final fix round, finding 1): createSessionRuntime() used to register
	// the per-run limits descriptor into the caller's PluginRegistry. That made a shared
	// registry single-use -- the second createSessionRuntime() threw
	// `Plugin "limits" is already registered` -- which the whole tree hid by passing a fresh
	// registry at all 15 call sites. S1a (concurrent requests) and S3 (pooling by specId) both
	// reuse one process-level registry, so this must hold.
	// Task 5 起 limits 是 createDefaultPluginRegistry() 里的进程级描述符,只被 lookup、
	// 不再被 register —— 这两条锁因此更强了:共享的表里现在**真的有**这个插件。
	it("creates two runtimes in sequence from one shared PluginRegistry", async () => {
		const shared = createDefaultPluginRegistry();

		const first = await build({ maxTurns: 5 }, [fauxAssistantMessage("first")], shared);
		const firstResult = await first.run("hello");
		expect(firstResult.status).toBe("completed");
		expect(firstResult.output).toContain("first");

		const second = await build({ maxTurns: 5 }, [fauxAssistantMessage("second")], shared);
		const secondResult = await second.run("hello");
		expect(secondResult.status).toBe("completed");
		expect(secondResult.output).toContain("second");
	});

	// The per-run limits state must stay per-run even when the registry is shared: runtime A
	// has maxTurns:1 (trips immediately) while runtime B has maxTurns:5 (must complete).
	// A shared LimitState would show up as B inheriting A's tripped limit.
	it("keeps per-run limit state isolated between two runtimes sharing one PluginRegistry", async () => {
		const shared = createDefaultPluginRegistry();
		const tripping = await build({ maxTurns: 1 }, [fauxAssistantMessage("a")], shared);
		const roomy = await build({ maxTurns: 5 }, [fauxAssistantMessage("b")], shared);

		const [trippedResult, roomyResult] = await Promise.all([tripping.run("hello"), roomy.run("hello")]);

		expect(trippedResult.status).toBe("limit_exceeded");
		expect(trippedResult.limit).toBe("maxTurns");
		expect(roomyResult.status).toBe("completed");
		expect(roomyResult.limit).toBeUndefined();
	});
});

describe("SessionRuntime - abortFn rejection handling", () => {
	// Regression lock (fix round 1): abortFn (used by the limits plugin's turn_end hook and by
	// the runTimeoutMs setTimeout) is a synchronous callback that cannot `await` session.abort().
	// If that promise rejects and nothing catches it, it becomes an unhandled rejection -- fatal
	// in modern Node. This forces that rejection via a prototype spy (mirrors the
	// ModelRuntime.prototype.getModel spy pattern in assembler.test.ts) and asserts the run still
	// settles normally instead of crashing the process/test worker.
	it("swallows a rejection from the internal abort triggered by a tripped limit", async () => {
		const abortSpy = vi.spyOn(AgentSession.prototype, "abort").mockRejectedValueOnce(new Error("abort boom"));
		cleanups.push(async () => {
			abortSpy.mockRestore();
		});

		const runtime = await build({ maxTurns: 1 }, [fauxAssistantMessage("done")]);
		const result = await runtime.run("hello");

		expect(abortSpy).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("maxTurns");
	});
});

// Regression lock for review finding I-1 (Task 4): the two plugin-registry.test.ts cases added
// alongside PluginContext only prove that instantiatePlugins()/resolveAll() forward a
// *hand-rolled* ctx -- they never touch session-runtime.ts:36-42, the one place that actually
// builds the production PluginContext. Nothing there would have caught `getRunId: () =>
// runIdSnapshot` or `abort: abortFn` (silently freezing the :11 no-op forever) -- both compile,
// both leave every other test green. These go through createSessionRuntime()'s real path: a
// registry-registered plugin declared via spec.extraPlugins, exactly like a real deployment would.
describe("SessionRuntime - PluginContext wiring (review I-1)", () => {
	function specWithProbe(limits: RuntimeSpec["limits"]): RuntimeSpec {
		return { ...spec(limits), extraPlugins: ["probe"] };
	}

	it("hands spec-declared plugins the real PluginContext: getRunId varies per run, getSession resolves to the live session", async () => {
		let capturedCtx: PluginContext | undefined;
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "probe",
			hooks: [],
			factory: (ctx) => {
				// Only capture the handles here -- the factory runs inside assemble(), before
				// createAgentSession() returns, i.e. before session-runtime.ts's `assembled` is
				// assigned. Calling ctx.getSession() *now* would throw; that's the point of the
				// lazy handle (mirrors plugin-registry.test.ts's "keeps getSession lazy" case, but
				// for the ctx session-runtime.ts actually builds instead of a hand-rolled one).
				capturedCtx = ctx;
				return { name: "probe", factory: () => {} };
			},
		});

		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const runtime = await createSessionRuntime({
			spec: specWithProbe({ maxTurns: 5 }),
			profile,
			registry,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(runtime.dispose);

		// getSession is lazy but must resolve to the *real, live* session once assemble() has
		// actually returned -- proven by matching identity against runtime.sessionId, not just
		// "didn't throw".
		expect(capturedCtx?.getSession().sessionId).toBe(runtime.sessionId);

		// getRunId's whole reason to exist (S3 pooling, Task 11's path-guard <runId> expansion) is
		// that it varies across run() calls on the same runtime -- pin that now, 6 tasks before
		// path-guard becomes the first real consumer.
		const first = await runtime.run("hello", { runId: "run-a" });
		expect(first.runId).toBe("run-a");
		expect(capturedCtx?.getRunId()).toBe("run-a");

		const second = await runtime.run("hello again", { runId: "run-b" });
		expect(second.runId).toBe("run-b");
		expect(capturedCtx?.getRunId()).toBe("run-b");
		expect(capturedCtx?.getRunId()).not.toBe("run-a");
	});

	it("forwards ctx.abort() to the real session.abort(), not a snapshot of the initial no-op", async () => {
		let capturedAbort: (() => void) | undefined;
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "probe",
			hooks: [],
			factory: (ctx) => {
				// Captured while `abortFn` (session-runtime.ts:11) is still the initial no-op --
				// if ctx.abort were `abortFn` (a value snapshot) instead of `() => abortFn()` (a
				// forwarding closure), calling this later would silently do nothing and the run
				// below would complete instead of aborting.
				capturedAbort = ctx.abort;
				return { name: "probe", factory: () => {} };
			},
		});

		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve(fauxAssistantMessage("late")), 200);
				}),
		]);
		const runtime = await createSessionRuntime({
			spec: specWithProbe({ maxTurns: 5 }),
			profile,
			registry,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(runtime.dispose);

		const runPromise = runtime.run("hello");
		await waitUntil(() => !runtime.isIdle);

		capturedAbort?.();

		const result = await runPromise;
		expect(result.status).toBe("aborted");
		expect(runtime.isIdle).toBe(true);
	});
});
