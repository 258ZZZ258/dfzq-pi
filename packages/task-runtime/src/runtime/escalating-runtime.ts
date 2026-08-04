import type { RunOptions, RunResult, Runtime, RuntimeEvent, RunUsage } from "./contract.ts";
import type { FastPathRuntime } from "./fast-path-runtime.ts";

function addUsage(a: RunUsage, b: RunUsage): RunUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		total: a.total + b.total,
		cost: a.cost + b.cost,
	};
}

/**
 * 阶段 1(快路径)→ 判升级 → 阶段 2(现有 agent 自主编排)的组合子。
 *
 * 对 RunManager 完全透明:`Runtime`(contract.ts:92)是它唯一的依赖,闸门 / 幂等 / 落库 /
 * 事件订阅全部复用,RunManager 一行不改。
 *
 * 🔴 **两阶段不共用 MCP 会话**(规格 D-5)。代价是升级路径要多装配一次 Runtime —— 一次新的
 * assemble() 调用,以及检索后端的一次首次调用开销(与 fast-path-runtime.ts 里"抢跑"要吃掉
 * 的是同一类冷启动耗时,见该文件 runFastInner 上方"抢跑"的注释),这份代价只落在已经放弃
 * 30s 窗口的那条路径上。换来的是**阶段 2 逐字等于今天的行为**:同一个 spec、同一次
 * assemble()、干净 context。于是
 *   - 阶段 1 检索过的 id 不会累进阶段 2 的 unfetched;
 *   - 阶段 1 那份被判不合格的答案不会残留在阶段 2 的 context 里 —— 让被拒绝的输出留在下游
 *     看得见的地方,这个仓库已经吃过一次亏(contract.ts 里 `answer` 字段文档记录的那次:
 *     被 C6 拒掉的臆造应答曾经原样进了 `answer`,后来才在 `toWireResult` 补上状态闸门);
 *   - 验收能直接拿今天的 run 做对照。
 *
 * 🔴 **`createFull` 惰性**:构造时就装配阶段 2 会让**每个 run 都白起一个 MCP 子进程**,
 * 而多数 run 不升级。只在真升级时调。
 */
export function createEscalatingRuntime(options: {
	fast: FastPathRuntime;
	createFull: () => Promise<Runtime>;
}): Runtime {
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let full: Runtime | undefined;
	let unsubscribeFull: (() => void) | undefined;

	// 落库层按 (run_id, seq) 做主键(store/sqlite.ts:30-37,`appendEvents` 撞主键会抛,由
	// `run-manager.ts` 的 `subscribeEvents` 接住、只打日志、判"this event is dropped")。
	// `fast` 与 `full` 是两个独立的 Runtime 实例,各自的 seq 计数器都从 0 起跳
	// (fast-path-runtime.ts:237 与 session-runtime.ts:48 各自的 `let seq = 0`),原样转发
	// 的话阶段 2 的事件会带着与阶段 1 撞号的 seq 出场,静默丢进上面那条日志分支 ——
	// A6 要对账的调用序列会因此出现看不见的缺口。这里在转发给订阅者之前统一重新编号,
	// 保证合成后的事件流里 seq 全局唯一、按到达这里的先后单调递增;两个子 Runtime 各自的
	// seq 只是各自的内部实现细节,合成后的流不承诺沿用它们。
	let nextSeq = 0;
	const fanOut = (event: RuntimeEvent) => {
		const enveloped: RuntimeEvent = { ...event, seq: nextSeq++ };
		for (const listener of listeners) {
			try {
				listener(enveloped);
			} catch (error) {
				console.error(
					`[EscalatingRuntime] event subscriber threw for "${enveloped.type}"; continuing fan-out`,
					error,
				);
			}
		}
	};
	const unsubscribeFast = options.fast.subscribe(fanOut);

	async function run(input: string, opts?: RunOptions): Promise<RunResult> {
		const { verdict, result: fastResult } = await options.fast.runFast(input, opts);
		// 收下 ⇒ 直接回,**createFull 一次都不调** —— 不起第二个 MCP 子进程。
		if (verdict.accept) return fastResult;

		// 升级。阶段 1 的输出到此为止:不进 output、不进 answer、不进阶段 2 的 context。
		// `fast_path_escalated` 事件已由 FastPathRuntime 发过(payload 只带 reason,不带任何
		// 阶段 1 的输出内容)。
		full = await options.createFull();
		unsubscribeFull = full.subscribe(fanOut);
		const fullResult = await full.run(input, opts);
		return {
			...fullResult,
			turns: fastResult.turns + fullResult.turns,
			usage: addUsage(fastResult.usage, fullResult.usage),
			durationMs: fastResult.durationMs + fullResult.durationMs,
		};
	}

	return {
		id: options.fast.id,
		specId: options.fast.specId,
		sessionId: options.fast.sessionId,
		run,
		steer: (text: string) => (full ?? options.fast).steer(text),
		followUp: (text: string) => (full ?? options.fast).followUp(text),
		// 转发到**当前活跃**的那一段:阶段 2 建起来之后它才是在跑的那个。
		abort: () => (full ?? options.fast).abort(),
		waitForIdle: () => (full ?? options.fast).waitForIdle(),
		subscribe: (listener: (event: RuntimeEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get isIdle() {
			return (full ?? options.fast).isIdle;
		},
		get lastActiveAt() {
			return Math.max(options.fast.lastActiveAt, full?.lastActiveAt ?? 0);
		},
		snapshot: () => options.fast.snapshot(),
		dispose: async () => {
			listeners.clear();
			// try/finally:阶段 2 的 dispose 抛出时**不能**跳过阶段 1 的 —— 跳过 = MCP 子进程
			// 不回收(与 run-manager.ts:315-325 同一条纪律)。
			try {
				unsubscribeFull?.();
				if (full) await full.dispose();
			} finally {
				unsubscribeFast();
				await options.fast.dispose();
			}
		},
	};
}
