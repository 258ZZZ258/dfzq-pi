import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { PluginRegistry } from "../src/runtime/plugin-registry.ts";
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

async function build(limits: RuntimeSpec["limits"], responses: unknown[], registry = new PluginRegistry()) {
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

describe("SessionRuntime - shared PluginRegistry", () => {
	// Regression lock (final fix round, finding 1): createSessionRuntime() used to register
	// the per-run limits descriptor into the caller's PluginRegistry. That made a shared
	// registry single-use -- the second createSessionRuntime() threw
	// `Plugin "limits" is already registered` -- which the whole tree hid by passing a fresh
	// `new PluginRegistry()` at all 15 call sites. S1a (concurrent requests) and S3 (pooling
	// by specId) both reuse one process-level registry, so this must hold.
	it("creates two runtimes in sequence from one shared PluginRegistry", async () => {
		const shared = new PluginRegistry();

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
		const shared = new PluginRegistry();
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
