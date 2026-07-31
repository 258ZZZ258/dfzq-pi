import type { RunOptions, RunResult, Runtime, RuntimeEvent, RuntimeSnapshot } from "../../src/runtime/contract.ts";

export interface StubRuntimeOptions {
	specId?: string;
	sessionId?: string;
	result?: Partial<RunResult>;
	/** 自动在这么久之后完成。与 hang 互斥 —— 两者同时传入会在 createStubRuntime() 里 throw。 */
	delayMs?: number;
	/** true 时 run() 永不自行完成,必须由 resolveNow() 推动 —— 用来测等待窗口超时。 */
	hang?: boolean;
}

export interface StubRuntime extends Runtime {
	/** 让挂起的 run() 立刻以配置的结果完成。 */
	resolveNow: () => void;
	readonly runCalls: number;
	readonly aborted: boolean;
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
	};
	return runtime;
}
