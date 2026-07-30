import type { RunOptions, RunResult, Runtime, RuntimeEvent, RuntimeSnapshot } from "../../src/runtime/contract.ts";

export interface StubRuntimeOptions {
	specId?: string;
	sessionId?: string;
	result?: Partial<RunResult>;
	/** 自动在这么久之后完成。与 hang 互斥。 */
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
	const specId = options.specId ?? "demo";
	const sessionId = options.sessionId ?? "sess-stub";
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let runCalls = 0;
	let aborted = false;
	let settle: (() => void) | undefined;

	function buildResult(runId: string): RunResult {
		return {
			runId,
			specId,
			status: aborted ? "aborted" : "completed",
			output: "stub output",
			usage: ZERO_USAGE,
			turns: 1,
			durationMs: 1,
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
				await new Promise<void>((resolve) => {
					settle = resolve;
				});
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
