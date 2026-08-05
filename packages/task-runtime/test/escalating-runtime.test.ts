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

/** Polls `predicate` until it's true, sleeping `stepMs` between checks. Throws after `timeoutMs`
 *  so a stuck condition fails fast with a clear message instead of hanging until vitest's own
 *  test timeout. 与 test/session-runtime.test.ts / test/fast-path-runtime.test.ts 的同名
 *  file-local helper逐字同源。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000, stepMs = 1): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
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

	// C-1(整支终审 Critical):RunManager.cancel() 唯一的动作是调用下面的 abort()
	// (run-manager.ts 的 cancel())。此前 abort() 之后若阶段 1 恰好以 accept:false 收尾
	// (无论是 runFast 的 catch 分支把"抛错"报成 error,还是半截文本正常返回后被判官判负),
	// run() 只看 verdict.accept,分不出"判负"与"被取消",于是照常 createFull() —— 一次
	// cancel 会被悄悄改判成再起一次完整的、900s 上限的 agent 路径。
	//
	// 这里模拟真实时序:abort() 在 fast.runFast() 尚未 resolve 时就被调用(cancel 落在阶段 1
	// 期间,与 RunManager.cancel() 的唯一触发路径完全一致);runFast() 之后才 resolve,带着
	// verdict:{accept:false} —— 特意让它的 result.status 仍是 "error"(不是 "aborted"),
	// 用来证明这条判断**不依赖** FastPathRuntime 自己是否把 status 修对:即便 fast 一侧的
	// 状态还停在旧值,EscalatingRuntime 也必须凭自己记下的"abort() 被调用过"这件事拦住
	// createFull(),不能指望从 fastResult.status 里反推。
	it("never builds stage 2 once abort() has been called, and reports status aborted with stage-1 usage/turns carried through", async () => {
		const createFull = vi.fn(async () => fullStub(result({ output: "full" })));
		const fastAbort = vi.fn(async () => {});
		let resolveRunFast!: (run: FastPathRun) => void;
		const pendingRunFast = new Promise<FastPathRun>((resolve) => {
			resolveRunFast = resolve;
		});
		const fast: FastPathRuntime = {
			...fastStub({ verdict: { accept: true }, result: result({}) }),
			abort: fastAbort,
			runFast: async () => pendingRunFast,
		};
		const rt = createEscalatingRuntime({ fast, createFull });

		const runPromise = rt.run("q");
		await rt.abort(); // cancel arrives while stage 1 is still in flight
		expect(fastAbort).toHaveBeenCalled(); // forwarded to the only stage that exists yet

		resolveRunFast({
			verdict: { accept: false, reason: "阶段 1 被取消" },
			result: result({
				output: "半截答案",
				status: "error", // 刻意不是 "aborted" —— 见上面用例文档字符串
				errorMessage: "阶段 1 抛错:AbortError",
				turns: 2,
				usage: usage(0.02),
			}),
		});

		const got = await runPromise;
		expect(createFull).not.toHaveBeenCalled(); // 不起第二个 MCP 子进程
		expect(got.status).toBe("aborted");
		expect(got.turns).toBe(2); // 阶段 1 已经花掉的 turns 如实带回,不是 0
		expect(got.usage.cost).toBeCloseTo(0.02); // 阶段 1 已经花掉的 usage 如实带回
	});

	// C-1(两阶段交界处,报告里"顺带想一件事"那部分对应的代码):上一条用例的 cancel 落在
	// `await options.fast.runFast()` 还没 resolve 时——那个窗口里 abort() 转发给的是
	// `options.fast`,还有东西可打断。这里让 cancel 落在**下一个**挂起点:`fastResult` 已经
	// resolve(verdict:false,决定要升级了),但 `await options.createFull()` 还没 resolve。
	// 这个窗口里 `full` 仍是 undefined,abort() 转发给的是**已经跑完**的 `options.fast`——一次
	// no-op,拦不住即将发生的 `full.run()`。若只查一次 stopRequested(在 fastResult resolve
	// 之后那次),这次 cancel 会被彻底放过,`full.run()` 照常起跑,复现同一个 Critical(只是
	// 窗口从"阶段 1 期间"变成了"阶段 2 装配期间")。
	it("does not start stage 2's run() when abort() lands between deciding to escalate and stage 2 finishing assembly", async () => {
		const fullRun = vi.fn(async () => result({ output: "full" }));
		const fullAbort = vi.fn(async () => {});
		let resolveCreateFull!: (rt: Runtime) => void;
		const pendingFull = new Promise<Runtime>((resolve) => {
			resolveCreateFull = resolve;
		});
		const createFull = vi.fn(() => pendingFull);
		const rt = createEscalatingRuntime({
			fast: fastStub({ verdict: { accept: false, reason: "x" }, result: result({ turns: 2, usage: usage(0.01) }) }),
			createFull,
		});

		const runPromise = rt.run("q");
		// fast.runFast() 在这个 stub 里同步 resolve(没有人为延迟)——等 run() 真正跑到
		// "await options.createFull()" 这一步,而不是还停在 "await options.fast.runFast()" 上,
		// 否则测的就是上一条用例已经覆盖过的窗口。
		await waitUntil(() => createFull.mock.calls.length > 0);

		await rt.abort(); // cancel 落在两阶段交界处:full 还没装配完,没有 runtime 可以真正 abort

		resolveCreateFull({ ...fullStub(result({})), run: fullRun, abort: fullAbort });
		const got = await runPromise;

		expect(fullRun).not.toHaveBeenCalled(); // 不起 900s 的 agent 路径
		expect(fullAbort).toHaveBeenCalled(); // 仍然调了(与 run-manager.ts 的 admitAndDrive() 同一条纪律),即便预期是 no-op
		expect(got.status).toBe("aborted");
		expect(got.turns).toBe(2); // 阶段 1 已经花掉的 turns 如实带回
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
