import type { RunOptions, RunResult, Runtime, RuntimeEvent, RuntimeSnapshot } from "../../src/runtime/contract.ts";

export interface StubRuntimeOptions {
	specId?: string;
	sessionId?: string;
	result?: Partial<RunResult>;
	/** 自动在这么久之后完成。与 hang 互斥 —— 两者同时传入会在 createStubRuntime() 里 throw。 */
	delayMs?: number;
	/** true 时 run() 永不自行完成,必须由 resolveNow() 推动 —— 用来测等待窗口超时。 */
	hang?: boolean;
	/**
	 * run() 开始时按数组顺序同步广播给订阅者的事件(缺省字段补 runId/specId/type/payload
	 * 的占位默认值)。用来在不碰真实 SessionRuntime 的前提下驱动「订阅者接住事件」这条链路
	 * ——例如 serve 侧事件落库(task-18b)要验证的正是 RunManager 有没有真的订阅了 runtime。
	 */
	events?: Array<Partial<RuntimeEvent>>;
}

export interface StubRuntime extends Runtime {
	/** 让挂起的 run() 立刻以配置的结果完成。 */
	resolveNow: () => void;
	readonly runCalls: number;
	readonly aborted: boolean;
	/**
	 * 手动向**当前**订阅者广播一条事件,不局限于 run() 期间。用来测试「订阅在 run 结束后是否
	 * 真的已经解除」这类时序敏感的场景(task-18b 复审 Important-2)——如果调用方在
	 * completion 落定之后还调这个方法,某个本该已经 unsubscribe 的监听器却还是收到了事件,
	 * 就说明解订阅没有真的生效。
	 */
	emit: (event: Partial<RuntimeEvent>) => void;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

export function createStubRuntime(options: StubRuntimeOptions = {}): StubRuntime {
	if (options.hang && options.delayMs != null) {
		throw new Error("createStubRuntime: hang 与 delayMs 互斥,不能同时传入");
	}
	const specId = options.specId ?? "demo";
	const sessionId = options.sessionId ?? "sess-stub";
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let runCalls = 0;
	let aborted = false;
	// 单槽位:同一时刻至多挂起一个 run()。见下方 run() 里的并发守卫 —— 这个槽位
	// 一旦被第二次调用覆盖,第一次的 Promise 就会永久孤儿挂起(vitest 超时而非报错)。
	let settle: (() => void) | undefined;

	/** run() 内部广播与外部手动 emit() 共用的同一份构造 + fan-out 逻辑。 */
	function broadcast(partial: Partial<RuntimeEvent>, defaultRunId: string) {
		const event: RuntimeEvent = {
			runId: defaultRunId,
			specId,
			seq: 0,
			ts: 0,
			type: "turn_end",
			payload: {},
			...partial,
		};
		for (const listener of listeners) listener(event);
	}

	function buildResult(runId: string): RunResult {
		return {
			runId,
			specId,
			status: aborted ? "aborted" : "completed",
			output: "stub output",
			// 每次都构造新对象 —— ZERO_USAGE 是模块级单例,直接复用引用会让某个用例
			// mutate 自己拿到的 usage 时,污染同文件里其他、逻辑上毫无关系的 stub 实例。
			usage: { ...ZERO_USAGE },
			turns: 1,
			durationMs: 1,
			judgeAttempts: {},
			...options.result,
		};
	}

	const runtime: StubRuntime = {
		id: "stub",
		specId,
		sessionId,
		isIdle: true,
		lastActiveAt: 0,
		get runCalls() {
			return runCalls;
		},
		get aborted() {
			return aborted;
		},
		async run(_input: string, opts?: RunOptions): Promise<RunResult> {
			runCalls++;
			const runId = opts?.runId ?? "run-stub";
			if (options.events) {
				for (const partial of options.events) broadcast(partial, runId);
			}
			if (options.hang) {
				if (settle) {
					throw new Error("stub runtime: 同一 stub 实例上已有挂起的 run(),不支持并发 run()");
				}
				await new Promise<void>((resolve) => {
					settle = resolve;
				});
				settle = undefined;
				return buildResult(runId);
			}
			if (options.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			}
			return buildResult(runId);
		},
		async steer() {},
		async followUp() {},
		async abort() {
			aborted = true;
			settle?.();
		},
		async waitForIdle() {},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		snapshot(): RuntimeSnapshot {
			return { sessionId };
		},
		async dispose() {},
		resolveNow() {
			settle?.();
		},
		emit(event: Partial<RuntimeEvent>) {
			broadcast(event, "run-stub");
		},
	};
	return runtime;
}
