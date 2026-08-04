import { describe, expect, it, vi } from "vitest";
import type { RunResult, Runtime, RuntimeEvent } from "../src/runtime/contract.ts";
import { createEscalatingRuntime } from "../src/runtime/escalating-runtime.ts";
import type { FastPathRun, FastPathRuntime } from "../src/runtime/fast-path-runtime.ts";

const usage = (cost: number) => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost });
const result = (over: Partial<RunResult>): RunResult => ({
	runId: "r",
	specId: "pq",
	status: "completed",
	usage: usage(0.01),
	turns: 2,
	durationMs: 100,
	judgeAttempts: {},
	...over,
});

const base = {
	id: "x",
	specId: "pq",
	sessionId: "s",
	steer: async () => {},
	followUp: async () => {},
	abort: async () => {},
	waitForIdle: async () => {},
	subscribe: () => () => {},
	isIdle: true,
	lastActiveAt: 0,
	snapshot: () => ({ sessionId: "s" }),
	dispose: async () => {},
};

function fastStub(run: FastPathRun): FastPathRuntime {
	return {
		...base,
		runFast: async () => run,
		run: async () => run.result,
		activeToolNamesForTest: () => [],
	};
}

function fullStub(r: RunResult): Runtime {
	return { ...base, run: async () => r };
}

describe("EscalatingRuntime", () => {
	it("returns the fast result and NEVER builds stage 2 when the verdict accepts", async () => {
		const createFull = vi.fn(async () => fullStub(result({ output: "full" })));
		const rt = createEscalatingRuntime({
			fast: fastStub({ verdict: { accept: true }, result: result({ output: "fast" }) }),
			createFull,
		});
		const got = await rt.run("q");
		expect(got.output).toBe("fast");
		expect(createFull).not.toHaveBeenCalled(); // 惰性:不升级就不起第二个 MCP 子进程
	});

	it("escalates and returns the stage-2 result, discarding stage 1 output entirely", async () => {
		// 阶段 1 的 status/errorMessage/stopReason/limit 全部设成非缺省值(真实升级时
		// status 必是 "error"/"limit_exceeded"、errorMessage 有值)——若实现改成
		// `{ ...fastResult, ...fullResult, ... }`,阶段 2 的 result() 里没有 errorMessage/
		// stopReason/limit 这几个键(可选字段、未传就不存在),spread 不会覆盖掉它们,
		// 阶段 1 的取值会原样透出。四个字段缺一都测不出这类"部分字段泄漏"。
		const rt = createEscalatingRuntime({
			fast: fastStub({
				verdict: { accept: false, reason: "confidence low" },
				result: result({
					output: "fast",
					status: "error",
					errorMessage: "阶段 1 判负原因",
					stopReason: "x",
					limit: "maxCostUsd",
				}),
			}),
			createFull: async () => fullStub(result({ output: "full" })),
		});
		const got = await rt.run("q");
		expect(got.output).toBe("full");
		expect(got.status).toBe("completed"); // 阶段 2 的值,不是阶段 1 的 "error"
		expect(got.errorMessage).toBeUndefined();
		expect(got.stopReason).toBeUndefined();
		expect(got.limit).toBeUndefined();
		expect(JSON.stringify(got)).not.toContain("fast"); // 阶段 1 输出不外露
	});

	it("sums usage and turns across both stages", async () => {
		const rt = createEscalatingRuntime({
			fast: fastStub({ verdict: { accept: false, reason: "x" }, result: result({ turns: 2, usage: usage(0.01) }) }),
			createFull: async () => fullStub(result({ turns: 9, usage: usage(0.05) })),
		});
		const got = await rt.run("q");
		expect(got.turns).toBe(11);
		expect(got.usage.cost).toBeCloseTo(0.06);
		expect(got.usage.total).toBe(6);
		expect(got.usage.input).toBe(2); // 顺手锁一下逐字段相加没有漏掉别的 usage 字段
	});

	it("disposes stage 2 as well when it was built", async () => {
		const dispose = vi.fn(async () => {});
		const rt = createEscalatingRuntime({
			fast: fastStub({ verdict: { accept: false, reason: "x" }, result: result({}) }),
			createFull: async () => ({ ...fullStub(result({})), dispose }),
		});
		await rt.run("q");
		await rt.dispose();
		expect(dispose).toHaveBeenCalled();
	});

	// try/finally 存在的唯一理由是"阶段 2 的 dispose 抛出也不能跳过阶段 1 的"——上一条用例
	// 只断言了"阶段 2 的 dispose 被调过",把 try/finally 换成三条顺序语句(阶段 2 dispose
	// 抛出后阶段 1 的 dispose 永远不会被执行到)照样全绿,锁不住这条不变量。这里让阶段 2 的
	// dispose 抛错,断言阶段 1 的 dispose 仍然被调用、且 rt.dispose() 仍然把这个错误传出去
	// (吞掉异常同样不对:调用方需要知道清理没有干净完成)。
	it("still disposes stage 1 when stage 2's dispose throws", async () => {
		const fastDispose = vi.fn(async () => {});
		const rt = createEscalatingRuntime({
			fast: { ...fastStub({ verdict: { accept: false, reason: "x" }, result: result({}) }), dispose: fastDispose },
			createFull: async () => ({
				...fullStub(result({})),
				dispose: async () => {
					throw new Error("boom");
				},
			}),
		});
		await rt.run("q");
		await expect(rt.dispose()).rejects.toThrow("boom");
		expect(fastDispose).toHaveBeenCalled();
	});

	it("forwards abort to the stage that is currently active", async () => {
		const fastAbort = vi.fn(async () => {});
		const rt = createEscalatingRuntime({
			fast: { ...fastStub({ verdict: { accept: true }, result: result({}) }), abort: fastAbort },
			createFull: async () => fullStub(result({})),
		});
		await rt.abort();
		expect(fastAbort).toHaveBeenCalled();
	});

	// 上一条用例只跑了 accept:true 那支(full 恒 undefined,abort() 只可能转发给 fast)——
	// "当前活跃"这句话的另一半(升级之后 abort() 应该转发给 full,不再是 fast)完全没有
	// 用例覆盖。这里跑升级分支,断言 abort() 落到 full 上、不再落到 fast 上。
	it("forwards abort to stage 2 once escalated", async () => {
		const fastAbort = vi.fn(async () => {});
		const fullAbort = vi.fn(async () => {});
		const rt = createEscalatingRuntime({
			fast: { ...fastStub({ verdict: { accept: false, reason: "x" }, result: result({}) }), abort: fastAbort },
			createFull: async () => ({ ...fullStub(result({})), abort: fullAbort }),
		});
		await rt.run("q");
		await rt.abort();
		expect(fullAbort).toHaveBeenCalled();
		expect(fastAbort).not.toHaveBeenCalled();
	});

	// fast 与 full 是两个独立的 Runtime 实例,各自的内部 seq 计数器都从 0 起跳
	// (fast-path-runtime.ts / session-runtime.ts 各自的 `let seq = 0`)。run-manager.ts 的
	// 事件落库按 (run_id, seq) 做主键(store/sqlite.ts:30-37),原样转发两段的事件会让阶段 2
	// 里落在阶段 1 已用掉的 seq 区间(`[0, 阶段 1 事件总数 - 1]`,有界的开头一段,不是整段
	// 阶段 2 事件流)内的那些事件带着撞号的 seq 出场,`store.appendEvents` 撞主键抛出的错误
	// 在 run-manager.ts 的 `subscribeEvents` 里只打日志、判"this event is dropped"——落在
	// 这个区间内的阶段 2 事件会因此从落库结果里静默消失。这里直接模拟"两个子 Runtime 都从
	// seq:0 开始发事件"这个真实场景,断言合成后的事件流里 seq 全局唯一、按到达 fanOut 的
	// 先后单调递增。
	it("renumbers seq across stages so stage-2 events never collide with stage-1 events", async () => {
		let fastListener: ((event: RuntimeEvent) => void) | undefined;
		let fullListener: ((event: RuntimeEvent) => void) | undefined;
		const fast: FastPathRuntime = {
			...fastStub({ verdict: { accept: false, reason: "x" }, result: result({}) }),
			subscribe: (listener) => {
				fastListener = listener;
				return () => {};
			},
		};
		const full: Runtime = {
			...fullStub(result({})),
			subscribe: (listener) => {
				fullListener = listener;
				return () => {};
			},
		};
		const rt = createEscalatingRuntime({ fast, createFull: async () => full });
		const seen: RuntimeEvent[] = [];
		rt.subscribe((event) => seen.push(event));

		const envelope = (seq: number, type: string): RuntimeEvent => ({
			runId: "r",
			specId: "pq",
			seq,
			ts: seq,
			type,
			payload: {},
		});
		fastListener?.(envelope(0, "a"));
		fastListener?.(envelope(1, "b"));
		await rt.run("q"); // subscribes to full as part of escalating
		fullListener?.(envelope(0, "c")); // full's own counter also starts at 0

		const seqs = seen.map((event) => event.seq);
		expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seq for this runId
		expect(seqs).toEqual([0, 1, 2]); // monotonic across the composed stream
	});
});
