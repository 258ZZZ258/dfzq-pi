import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import type { RuntimeEvent } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { FinalJudge } from "../src/runtime/final-judge.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage, fauxToolCall } from "./helpers/faux.ts";

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

/** 装一个带任意判官的 runtime。spec 默认 maxTurns:10 + demo/echo,按需覆盖。 */
async function buildWithRegistry(
	registry: ReturnType<typeof createDefaultPluginRegistry>,
	specOverrides: Partial<RuntimeSpec>,
	responses: unknown[],
	toolsetRegistry: ToolsetRegistry = toolsets(),
) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses(responses as never);
	const runtime = await createSessionRuntime({
		spec: { ...spec({ maxTurns: 10 }), ...specOverrides },
		profile,
		registry,
		toolsets: toolsetRegistry,
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	});
	cleanups.push(runtime.dispose);
	return runtime;
}

/** 登记一个判官的最小测试插件。`judge` 直接给,免得每条用例都抄一遍 register 样板。 */
function registryWithCustomJudge(name: string, judge: FinalJudge["judge"], overrides: Partial<FinalJudge> = {}) {
	const registry = createDefaultPluginRegistry();
	// 机器校验:撞上默认表里的四个插件时,register() 会抛一句
	// "already registered",而错误里没有"这是测试自己起错名"这层信息。
	// 先在这里响亮地说清楚,免得下一个人去查装配逻辑。
	expect(registry.has(name), `测试插件名 "${name}" 与默认插件表撞名,换一个`).toBe(false);
	registry.register({
		name,
		hooks: [],
		factory: (ctx) => {
			ctx.registerFinalJudge({ name, maxAttempts: 3, onExhausted: "pass", judge, ...overrides });
			return { name, factory: () => {} };
		},
	});
	return registry;
}

/** 只用来登记一个可编程判官的测试插件。verdicts 用完后重复最后一项。 */
function registryWithJudge(verdicts: Array<{ ok: boolean }>) {
	const registry = createDefaultPluginRegistry();
	let call = 0;
	registry.register({
		name: "test-judge",
		hooks: [],
		factory: (ctx) => {
			ctx.registerFinalJudge({
				name: "test-judge",
				maxAttempts: 5,
				onExhausted: "pass",
				judge: async () => {
					const verdict = verdicts[Math.min(call, verdicts.length - 1)];
					call += 1;
					return verdict?.ok ? { ok: true } : { ok: false, followUp: "请继续查证" };
				},
			});
			return { name: "test-judge", factory: () => {} };
		},
	});
	return registry;
}

async function buildWithJudge(limits: RuntimeSpec["limits"], verdicts: Array<{ ok: boolean }>, responses: unknown[]) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses(responses as never);
	const runtime = await createSessionRuntime({
		spec: { ...spec(limits), stopPolicy: "test-judge" },
		profile,
		registry: registryWithJudge(verdicts),
		toolsets: toolsets(),
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	});
	cleanups.push(runtime.dispose);
	return runtime;
}

describe("SessionRuntime final-judge rejudging", () => {
	it("re-prompts the session when a judge rejects, and keeps counting turns across prompts", async () => {
		const runtime = await buildWithJudge(
			{ maxTurns: 10 },
			[{ ok: false }, { ok: false }, { ok: true }],
			[fauxAssistantMessage("第一版"), fauxAssistantMessage("第二版"), fauxAssistantMessage("第三版")],
		);
		const events: RuntimeEvent[] = [];
		runtime.subscribe((event) => events.push(event));
		const result = await runtime.run("hello");
		expect(result.status).toBe("completed");
		expect(result.output).toContain("第三版");
		// turns 跨三次 prompt 累加 —— 不是每次 prompt 归零。maxTurns 因此仍然是重判的硬顶。
		expect(result.turns).toBeGreaterThanOrEqual(3);

		// 副作用锁:重判在 run 层重新发 prompt,所以**一个 run 会产生多次 agent_end**
		// (这里实测 3 次 agent_start / turn_end / agent_end / agent_settled),而 runId
		// 全程不变。S2 的观测层与工具调用对账不得假设"一 run 一 agent_end" —— 谁靠那条
		// 不变量切分 run 边界,这条断言就是他的告警。
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(3);
		expect(new Set(events.map((event) => event.runId))).toEqual(new Set([result.runId]));
	});

	it("does not re-prompt once maxTurns has tripped", async () => {
		// 判官恒判不通过。maxTurns:1 会在第一次 prompt 结束时就置位 state.tripped,
		// shouldStop() 因此在第一轮重判前就为 true —— 结果必须是 limit_exceeded 而不是 error。
		const runtime = await buildWithJudge(
			{ maxTurns: 1 },
			[{ ok: false }],
			[fauxAssistantMessage("只此一版"), fauxAssistantMessage("不该出现")],
		);
		const result = await runtime.run("hello");
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("maxTurns");
		expect(result.output).toContain("只此一版");
	});

	// 锁住 clearTimeout 的位置。实现里它被刻意从第一层 finally 挪到了重判之后(brief 原文
	// 把重判插在 finally 之后,那样 runTimeout 的定时器在第一次 prompt() 返回时就死了,
	// session-runtime.ts 里"runTimeoutMs 横跨全部重判"的注释便是空话):判官还能再发
	// Σ maxAttempts 次 prompt,足以把一个声明了 100ms 上限的 run 拖到秒级。
	// 第一次应答是即时的(定时器来不及在它身上触发),之后每次应答 200ms —— 触发点因此
	// 必然落在重判途中。定时器若提前被清,这条会变成 completed。
	it("lets runTimeoutMs trip during rejudging instead of dying with the first prompt", async () => {
		const slow = () =>
			new Promise((resolve) => {
				setTimeout(() => resolve(fauxAssistantMessage("慢")), 200);
			});
		const runtime = await buildWithJudge(
			{ runTimeoutMs: 100 },
			[{ ok: false }],
			[fauxAssistantMessage("第一版"), slow, slow, slow, slow, slow],
		);
		const result = await runtime.run("hello");
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("runTimeout");
	});

	it("reports error when a judge itself throws", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([fauxAssistantMessage("答案")] as never);
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "throwing-judge",
			hooks: [],
			factory: (ctx) => {
				ctx.registerFinalJudge({
					name: "throwing-judge",
					maxAttempts: 2,
					onExhausted: "pass",
					judge: async () => {
						throw new Error("assess 调用失败");
					},
				});
				return { name: "throwing-judge", factory: () => {} };
			},
		});
		const runtime = await createSessionRuntime({
			spec: { ...spec({ maxTurns: 5 }), stopPolicy: "throwing-judge" },
			profile,
			registry,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(runtime.dispose);
		const result = await runtime.run("hello");
		// 判官抛异常不能变成静默成功 —— run 层的 .catch 把它转成 errorMessage。
		expect(result.status).toBe("error");
		expect(result.errorMessage).toContain("assess 调用失败");
	});

	// 审查 I-2 的回归锁。判官 await 期间 runTimeout 到期、之后判官又抛 —— judgeError 与
	// state.tripped 同时置位。classify() 自己确立的优先级是 limit 压倒 error,所以 status
	// 必须是 limit_exceeded;写成 `judgeError ? "error" : classify(...)` 会产出
	// status:"error" 配 limit:"runTimeout" 这种自相矛盾的结果,下游按 status==="limit_exceeded"
	// 记预算超支的会直接漏记。C6 明确用 onExhausted:"error",这个分歧必然会遇上。
	it("lets a tripped limit outrank a judge error in the RunResult status", async () => {
		const runtime = await buildWithRegistry(
			registryWithCustomJudge("slow-throwing-judge", async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				throw new Error("assess 调用失败");
			}),
			{ limits: { runTimeoutMs: 50 }, stopPolicy: "slow-throwing-judge" },
			[fauxAssistantMessage("第一版")],
		);
		const result = await runtime.run("hello");
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("runTimeout");
		// 诊断信息不丢:判官的失败原因仍然留在 errorMessage 里。
		expect(result.errorMessage).toContain("assess 调用失败");
	});

	// Task 8:C6(输出契约判官)的接线锁。
	describe("C6 output-contract judge wiring", () => {
		const minimalContractSchema = {
			type: "object",
			required: ["conclusion"],
			additionalProperties: false,
			properties: { conclusion: { type: "string" } },
		};

		async function buildWithOutputContract(
			registry: ReturnType<typeof createDefaultPluginRegistry>,
			specOverrides: Partial<RuntimeSpec>,
			outputContractSchema: unknown,
			responses: unknown[],
		) {
			const harness = await createFauxHarness();
			cleanups.push(harness.cleanup);
			harness.faux.setResponses(responses as never);
			const runtime = await createSessionRuntime({
				spec: { ...spec({ maxTurns: 10 }), ...specOverrides },
				profile,
				registry,
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
				outputContractSchema,
			});
			cleanups.push(runtime.dispose);
			return runtime;
		}

		// 既有 spec(没有 outputContract 字段)必须一字不变:哪怕调用方手滑传了
		// outputContractSchema,只要 spec.outputContract 是 undefined,C6 就不能挂上 ——
		// 否则一段散文式的回答会被判"未找到 JSON"而不是照常 completed。
		it("does not mount C6 when spec.outputContract is undefined, even if outputContractSchema is supplied", async () => {
			const runtime = await buildWithOutputContract(createDefaultPluginRegistry(), {}, minimalContractSchema, [
				fauxAssistantMessage("这是一段散文,不含任何 JSON"),
			]);
			const result = await runtime.run("hello");
			expect(result.status).toBe("completed");
			expect(result.output).toContain("这是一段散文");
		});

		// 审查 Important-2 订正:对称的另一半此前是"静默不挂 C6",而不是"响亮失败"——
		// spec 声明了 outputContract,调用方(比如曾经的 cli/main.ts)忘了把读好的 schema
		// 传进来,createSessionRuntime 现在必须在装配期就直接抛,而不是悄悄跑出一个
		// completed 的 run、让 Java 拿到一个从没被校验过的输出。"装配期失败要早要响"是
		// 全仓一贯纪律(assemble() 的 validateSpec、工具名交叉校验都是这条纪律的例子),
		// 一个"存在意义就是把静默错误变成响亮失败"的判官更不能自己开这个口子。
		it("throws instead of silently skipping C6 when spec.outputContract is declared but outputContractSchema is missing", async () => {
			await expect(
				buildWithOutputContract(
					createDefaultPluginRegistry(),
					{ outputContract: { schema: "answer.schema.json" } },
					undefined,
					[fauxAssistantMessage("这是一段散文,不含任何 JSON")],
				),
			).rejects.toThrow(/outputContract is declared but outputContractSchema was not supplied/);
		});

		// 顺序断言的真身:brief 的 Step 7 只用假判官证明了 runFinalJudges 按数组顺序派发,
		// 这里换成 session-runtime.ts 真实的接线路径 —— 一个通过插件在 assemble() 内部
		// registerFinalJudge 的判官(充当 C3),配上真的 outputContractSchema(真正的 C6)。
		// 第一版回答完全没有 JSON,对两个判官来说都会不通过;若 C6 排在前面,第一次 reprompt
		// 发的就会是 C6 的"未找到 JSON"文案。用 prompt 的 spy 直接读派发的文本,证明先发出去
		// 的是排在前面的插件判官的 followUp。
		it("dispatches the plugin-registered judge's followUp before C6's when both would reject the first draft", async () => {
			const promptSpy = vi.spyOn(AgentSession.prototype, "prompt");
			cleanups.push(async () => {
				promptSpy.mockRestore();
			});

			// 第一次不通过、第二次通过 —— 与 buildWithJudge 用的 verdicts 列表是同一套模式,
			// 只是这里要走真实的 createSessionRuntime + 真实的 C6,所以手写一个带计数的判官。
			let sufficiencyCalls = 0;
			const registry = registryWithCustomJudge("faux-evidence-gate", async () => {
				sufficiencyCalls += 1;
				if (sufficiencyCalls === 1) return { ok: false, followUp: "插件判官要求先补充证据" };
				return { ok: true };
			});
			const runtime = await buildWithOutputContract(
				registry,
				{
					stopPolicy: "faux-evidence-gate",
					outputContract: { schema: "answer.schema.json", maxRepairAttempts: 2 },
				},
				minimalContractSchema,
				[fauxAssistantMessage("第一版全是散文"), fauxAssistantMessage(JSON.stringify({ conclusion: "允许" }))],
			);

			const result = await runtime.run("hello");

			expect(promptSpy.mock.calls[0]?.[0]).toBe("hello");
			// 关键断言:第一次 reprompt 派发的是插件判官的文案,不是 C6 的
			// "未找到 JSON 块"—— 尽管第一版回答对 C6 来说也确实不合格。
			expect(promptSpy.mock.calls[1]?.[0]).toBe("插件判官要求先补充证据");

			// 插件判官第二次通过、C6 也认可第二版 JSON —— run 应当顺利收尾。
			expect(result.status).toBe("completed");
			expect(result.output).toContain('"conclusion":"允许"');
		});

		// C6 的 onExhausted:"error" 落地:重试次数耗尽仍不合格时,run 必须报 error 而不是
		// 悄悄放行一个 Java 解析不了的输出。
		it("reports status=error once maxRepairAttempts is exhausted and the output still fails the schema", async () => {
			const runtime = await buildWithOutputContract(
				createDefaultPluginRegistry(),
				{ outputContract: { schema: "answer.schema.json", maxRepairAttempts: 1 } },
				minimalContractSchema,
				[
					fauxAssistantMessage("第一版全是散文"),
					fauxAssistantMessage("第二版还是散文"),
					fauxAssistantMessage("不该出现的第三版"),
				],
			);
			const result = await runtime.run("hello");
			expect(result.status).toBe("error");
			expect(result.errorMessage).toContain("未找到 JSON");
		});

		// 审查 Minor-b 的回归锁:`maxRepairAttempts ?? 2` 的默认值此前无测试守着 —— 把默认值
		// 改成 `?? 99` 时 287 条全绿。这里不写 maxRepairAttempts,spec 只给 3 版恒不合格的
		// 散文回答(= 初次 + 默认 2 次重试),断言 prompt 恰好被调用 3 次、status 为 error。
		// 若默认值被改大(比如 99),maxTurns:10 会先被撞到,status 会变成 limit_exceeded
		// 而不是 error,promptSpy 的调用次数也不会停在 3 —— 两条断言都能拦住这类回退。
		it("defaults maxRepairAttempts to 2 when the spec omits it", async () => {
			const promptSpy = vi.spyOn(AgentSession.prototype, "prompt");
			cleanups.push(async () => {
				promptSpy.mockRestore();
			});
			const runtime = await buildWithOutputContract(
				createDefaultPluginRegistry(),
				{ outputContract: { schema: "answer.schema.json" } }, // 不写 maxRepairAttempts
				minimalContractSchema,
				[
					fauxAssistantMessage("第一版全是散文"),
					fauxAssistantMessage("第二版还是散文"),
					fauxAssistantMessage("第三版依然是散文"),
				],
			);
			const result = await runtime.run("hello");
			expect(result.status).toBe("error");
			expect(promptSpy.mock.calls).toHaveLength(3);
		});
	});

	// 审查 M-2 的回归锁:`thrown !== undefined 跳过重判`这条不变量此前只靠读代码验证。
	it("skips rejudging entirely when session.prompt() itself throws", async () => {
		const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockRejectedValueOnce(new Error("prompt boom"));
		cleanups.push(async () => {
			promptSpy.mockRestore();
		});
		let judgeCalls = 0;
		const runtime = await buildWithRegistry(
			registryWithCustomJudge("counting-judge", async () => {
				judgeCalls += 1;
				return { ok: false, followUp: "请继续查证" };
			}),
			{ stopPolicy: "counting-judge" },
			[fauxAssistantMessage("不该出现")],
		);
		const result = await runtime.run("hello");
		expect(result.status).toBe("error");
		expect(result.errorMessage).toBe("prompt boom");
		// prompt 自身就炸了,重判一次都不能进 —— 再发只会拿到第二次爆炸。
		expect(judgeCalls).toBe(0);
	});
});

/** 吐一段带 clause_id 的 JSON 的工具集。形态照着真实 MCP 工具结果:结构化数据塞在一段 JSON
 *  字符串里,而不是直接挂在结果对象上 —— collectClauseIds 的 tryParseJson 分支正是为它写的。 */
function toolsetsWithClauses(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("clauses", async () => [
		{
			name: "lookup",
			label: "Lookup",
			description: "Look a clause up.",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_id: string, params: { q: string }) => {
				// AgentToolResult.content 是 (TextContent | ImageContent)[](packages/agent/src/types.ts),
				// clause_id 只藏在这段 text 的 JSON 里 —— 正是 collectClauseIds 的 tryParseJson 分支
				// 要走通的那条路,也是 MCP 工具结果的常见形态。
				const payload = JSON.stringify({ hits: [{ clause_id: params.q, text: "……" }] });
				return { output: payload, content: [{ type: "text", text: payload }], details: {} };
			},
		} as never,
	]);
	return registry;
}

function toolsetsWithSourceDetails(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("source-details", async () => [
		{
			name: "get_clause_detail",
			label: "Get clause detail",
			description: "Fetch the authoritative clause text.",
			parameters: Type.Object({ clause_id: Type.String() }),
			execute: async (_id: string, params: { clause_id: string }) => {
				const sourceDetail = { clause_id: params.clause_id, text: "权威正文", doc_title: "监管规则" };
				const payload = JSON.stringify({ items: [sourceDetail] });
				return {
					output: payload,
					content: [{ type: "text", text: payload }],
					details: { source_details: [sourceDetail] },
				};
			},
		} as never,
	]);
	return registry;
}

/** 在 toolsetsWithClauses() 之外再加一个必失败的工具:抛出的 Error message 是一段能被
 *  tryParseJson 解开的 JSON,且里面回显了调用参数里的 clause_id —— 照着
 *  toolsets/mcp/adapter.ts 的真实链路:MCP server 对业务级失败返回 isError:true 时,
 *  mcp/client.ts 的 callTool() 把 server 原样返回的 content 文本(常见形态就是回显查询参数,
 *  比如"未找到 clause_id: X"的错误 payload)不加前缀地塞进 result.text,adapter.ts 据此
 *  throw new Error(result.text);pi 的 agent-loop 把它包成 createErrorToolResult(message) =
 *  `{ content:[{type:"text",text:message}], details:{} }`、isError:true。这里直接在 execute()
 *  里 throw 同形态的 message,不必真起一个 MCP server。 */
function toolsetsWithClauseAndFailure(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("clauses", async () => [
		{
			name: "lookup",
			label: "Lookup",
			description: "Look a clause up.",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_id: string, params: { q: string }) => {
				const payload = JSON.stringify({ hits: [{ clause_id: params.q, text: "……" }] });
				return { output: payload, content: [{ type: "text", text: payload }], details: {} };
			},
		} as never,
		{
			name: "lookupFail",
			label: "Lookup (fails)",
			description: "Look a clause up but always fail, echoing the queried id in the error payload.",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_id: string, params: { q: string }) => {
				throw new Error(JSON.stringify({ error: "not_found", clause_id: params.q }));
			},
		} as never,
	]);
	return registry;
}

// 审查 I-4:clauseIds 的接线此前零覆盖 —— grep 只命中 collectClauseIds 的纯函数单测,没有任何
// 测试证明 tool_execution_end 真的会填充它、它真的送达判官、clear() 真的挡住跨 run 串数据。
// 这三条正是风险 10 说的"上游改字段名会静默失效"的失效面,而 C3/C6 直接压在上面。
describe("SessionRuntime - clauseIds wiring (review I-4)", () => {
	it("carries successful authoritative source details into the completed RunResult", async () => {
		const runtime = await buildWithRegistry(
			createDefaultPluginRegistry(),
			{ toolset: "source-details", tools: ["get_clause_detail"] },
			[
				fauxAssistantMessage([fauxToolCall("get_clause_detail", { clause_id: "A-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("答完了"),
			],
			toolsetsWithSourceDetails(),
		);

		const result = await runtime.run("hello");
		expect(result.status).toBe("completed");
		expect(result.sourceDetails).toEqual([{ clause_id: "A-1", text: "权威正文", doc_title: "监管规则" }]);
	});

	it("feeds clause_ids from tool results into JudgeContext and clears them between runs", async () => {
		const seen: string[][] = [];
		const runtime = await buildWithRegistry(
			registryWithCustomJudge("recording-judge", async (context) => {
				seen.push([...context.clauseIds]);
				return { ok: true };
			}),
			{ toolset: "clauses", tools: ["lookup"], stopPolicy: "recording-judge" },
			[
				fauxAssistantMessage([fauxToolCall("lookup", { q: "A-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("第一次答完"),
				fauxAssistantMessage("第二次答完"),
			],
			toolsetsWithClauses(),
		);

		const first = await runtime.run("hello");
		expect(first.status).toBe("completed");
		// ① tool_execution_end 真的填充了 clauseIds ② 它真的送达了判官
		expect(seen[0]).toEqual(["A-1"]);

		// ③ run() 开头的 clauseIds.clear() 真的挡住跨 run 串数据:第二次 run 没有工具调用,
		//    判官看到的必须是空集,而不是上一次的 A-1。
		const second = await runtime.run("hello again");
		expect(second.status).toBe("completed");
		expect(seen[1]).toEqual([]);
	});

	// 锁住 session-runtime.ts 里 collectClauseIds 外面那圈 try/catch。它保护的是"不让我们这行
	// 打死在跑的 agent loop" —— 那段代码跑在 pi 无 try/catch 的 AgentSession._emit 里。
	//
	// fixture 的关键是 getter **只抛第一次**:我们的 subscriber 在 pi 之前先读到 details,
	// 于是第一次读由我们吃掉;pi 后来那次读(agent-loop.ts 的 `details: finalized.result.details`
	// 只是引用读,本来也不枚举自有属性)拿到正常值,run 照常跑完。
	// 恒抛的 getter 做不到这件事 —— 那种 fixture 无论有没有 try/catch 都以 error 收场,
	// 不具判别性(初版报告据此断言"造不出隔离 fixture",是错的,复审构造出来了)。
	it("keeps the run alive when collecting clause_ids throws inside pi's unprotected _emit", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		cleanups.push(async () => {
			errorSpy.mockRestore();
		});

		let reads = 0;
		const boobytrapped = {};
		Object.defineProperty(boobytrapped, "boobytrap", {
			enumerable: true,
			get() {
				reads += 1;
				if (reads === 1) throw new Error("one-shot boom");
				return {};
			},
		});

		const hostile = new ToolsetRegistry();
		hostile.register("clauses", async () => [
			{
				name: "lookup",
				label: "Lookup",
				description: "Look a clause up.",
				parameters: Type.Object({ q: Type.String() }),
				// details 是工具私有结构,不进 provider 请求,因此不受"必须可序列化"约束 ——
				// 装得下带 getter 的对象。
				execute: async () => ({
					output: "ok",
					content: [{ type: "text", text: "ok" }],
					details: boobytrapped,
				}),
			} as never,
		]);

		const seen: string[][] = [];
		const runtime = await buildWithRegistry(
			registryWithCustomJudge("recording-judge", async (context) => {
				seen.push([...context.clauseIds]);
				return { ok: true };
			}),
			{ toolset: "clauses", tools: ["lookup"], stopPolicy: "recording-judge" },
			[
				fauxAssistantMessage([fauxToolCall("lookup", { q: "A-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("答完了"),
			],
			hostile,
		);

		const result = await runtime.run("hello");
		// 去掉那圈 try/catch,这三条会变成 status:"error" / errorMessage:"one-shot boom"。
		expect(result.status).toBe("completed");
		expect(result.errorMessage).toBeUndefined();
		expect(result.output).toContain("答完了");
		// 采集失败降级成一条日志,判官照常被驱动、拿到空的 clauseIds。
		expect(reads).toBeGreaterThanOrEqual(1);
		expect(seen[0]).toEqual([]);
		expect(errorSpy).toHaveBeenCalled();
	});
});

// Task 9 语义决策:一次失败的工具调用(pi 的 tool_execution_end.isError === true)不该给
// C3/C6 贡献 clause_id,哪怕它的错误文本里回显了查询参数。见 toolsetsWithClauseAndFailure()
// 顶上的注释——这不是假想场景,是 toolsets/mcp/adapter.ts + mcp/client.ts 现有链路会真的产生
// 的形状:MCP server 对一次业务级失败(比如"没这个 clause_id")返回 isError:true 时,
// client.callTool() 原样保留 server 的 content 文本、不加任何前缀地塞进 result.text,
// adapter.ts 据此 throw,pi 把它包成 { content:[{type:"text",text:message}], details:{} }。
// 若这段回显文本恰好能被 tryParseJson 解开(常见错误 payload 形态),不过滤 isError 就会把
// "查了但没查到"算成"已检索到",直接喂给 C3 的充分性判定和 C6 的反幻觉校验。
describe("SessionRuntime - clause_id collection ignores isError results (Task 9)", () => {
	it("does not let a failed tool call's echoed clause_id count as evidence", async () => {
		const seen: string[][] = [];
		const runtime = await buildWithRegistry(
			registryWithCustomJudge("recording-judge", async (context) => {
				seen.push([...context.clauseIds]);
				return { ok: true };
			}),
			{ toolset: "clauses", tools: ["lookup", "lookupFail"], stopPolicy: "recording-judge" },
			[
				fauxAssistantMessage([fauxToolCall("lookup", { q: "A-1" }), fauxToolCall("lookupFail", { q: "Z-9" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("答完了"),
			],
			toolsetsWithClauseAndFailure(),
		);

		const result = await runtime.run("hello");
		expect(result.status).toBe("completed");
		// lookup 成功、真的贡献了 A-1;lookupFail 抛错、isError:true,它回显的 Z-9 不该出现。
		expect(seen[0]).toEqual(["A-1"]);
	});
});

/** 判官只有被 spec 声明后才会实例化 —— 光注册进表不够。 */
async function buildDeclaring(
	pluginName: string,
	registry: ReturnType<typeof createDefaultPluginRegistry>,
	responses: unknown[],
) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses(responses as never);
	const runtime = await createSessionRuntime({
		spec: { ...spec({ maxTurns: 5 }), stopPolicy: pluginName },
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

describe("judgeAttempts 上到 RunResult", () => {
	it("reports how many times each judge actually rejudged", async () => {
		// 验收要区分「一次答对」与「靠重判才合规」—— 只看 status=completed 分不出来。
		// 此前 runFinalJudges 算了这个数,session-runtime 却整个丢弃,只有单测能观测到。
		let calls = 0;
		const registry = registryWithCustomJudge("counting-attempts", async () => {
			calls += 1;
			return calls === 1 ? { ok: false, followUp: "再来一次" } : { ok: true };
		});
		const runtime = await buildDeclaring("counting-attempts", registry, [
			fauxAssistantMessage("一稿"),
			fauxAssistantMessage("二稿"),
		]);
		const result = await runtime.run("hello");
		expect(result.judgeAttempts["counting-attempts"]).toBe(1);
	});

	it("reports zero attempts when the judge passes on the first draft", async () => {
		const registry = registryWithCustomJudge("passing-judge", async () => ({ ok: true }));
		const runtime = await buildDeclaring("passing-judge", registry, [fauxAssistantMessage("一稿")]);
		const result = await runtime.run("hello");
		expect(result.judgeAttempts["passing-judge"]).toBe(0);
	});

	it("is an empty object when there are no judges at all", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("一稿")]);
		const result = await runtime.run("hello");
		expect(result.judgeAttempts).toEqual({});
	});
});
