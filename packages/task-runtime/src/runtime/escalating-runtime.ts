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
 * C-1:有人已经调用过 abort()——阶段 1 的 accept:false 不是"判负",是"被打断"。不升级、
 * 不(继续)起阶段 2 的 agent 路径,把阶段 1 已经花掉的 usage/turns 如实带回,status 改写成
 * "aborted"——与 run-manager.ts 的 finishAsAborted()、session-runtime.ts 的 classify() 同一
 * 口径("aborted" 专指用户取消)。显式清掉 `limit`:即便这次 accept:false 恰好也带着一个
 * tripped 值(限额/超时与取消极窄时间内竞速的边界情形),`status:"aborted"` 配
 * `limit:"runTimeout"` 这种组合正是 fast-path-runtime.ts 的 checkPreempted 注释点名过的
 * "自相矛盾组合"——两者不同,不能被这次改写混在一起带出去。
 *
 * `createEscalatingRuntime.run()` 里有两处调用:`stopRequested` 在 `await options.fast.runFast()`
 * 与 `await options.createFull()` 各自之后都要单独查一次——两次 await 之间都是真正的挂起点,
 * cancel 可以落在其中任何一个窗口里,查过一次不代表第二个窗口也安全。
 */
function abortedResult(fastResult: RunResult): RunResult {
	return { ...fastResult, status: "aborted", limit: undefined };
}

/**
 * 阶段 1(快路径)→ 判升级 → 阶段 2(现有 agent 自主编排)的组合子。
 *
 * 对 RunManager 完全透明:`Runtime`(contract.ts:92)是它唯一的依赖,闸门 / 幂等 / 落库 /
 * 事件订阅全部复用,RunManager 一行不改。
 *
 * 🔴 **两阶段不共用 MCP 会话**(规格 D-5)。代价是升级路径要多装配一次 Runtime —— 一次新的
 * assemble() 调用,以及检索后端的一次首次调用开销(与 fast-path-runtime.ts 里"抢跑"要吃掉
 * 的是同一类冷启动耗时,见该文件 runFastInner 开头"抢跑"的注释),这份代价只落在已经放弃
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
	// 假设同一个实例只 `run()` 一次:第二次 `run()` 会直接覆盖 full/unsubscribeFull,旧的
	// 阶段 2 既不会被解订阅、也不会被 dispose。生产上不可达(RunManager.drive() 每个 run
	// 用一个新装配的 Runtime、一次 dispose 收尾),但 `Runtime.run()` 的类型签名本身没有
	// 禁止调用方多次调用同一个实例——这里不做防御,只把假设写清楚。

	// C-1(整支终审 Critical):RunManager.cancel()(server/run-manager.ts)唯一的动作就是调用
	// 下面 return 里的 `abort()`。此前 `run()` 只看 `verdict.accept` 决定要不要 `createFull()`
	// ——`FastPathRuntime` 把"判负"与"被取消"都压成 `accept:false`(两者都可能是
	// `runFast()` 的 catch 分支把"抛错"报成非 completed,也可能是半截文本正常返回后被判官
	// 判负,fast-path-runtime.ts 的 `stopRequested` 注释详述过这条),`run()` 分不出来,于是
	// 一次 cancel 会被悄悄改判成再起一个 MCP 子进程、跑一遍 900s 上限的 agent 路径。
	//
	// `stopRequested` 只能记在**这一层**:RunManager 直接调用的就是这里的 `abort()`,不管当时
	// 转发给 fast 还是 full,"有人明确要求停"这个事实只有这里能确定地记下来——不依赖
	// `fastResult.status` 是否已经被 `FastPathRuntime` 自己修对(即便还没修对,这里也要独立
	// 拦住,见下面 `run()` 里的用法与该分支上方的用例)。
	let stopRequested = false;

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

		// C-1:两次检查中的第一次(见上面 `abortedResult` 附近的注释——为什么是两次、为什么两次
		// 都必须查)。有人已经调用过 abort(),这次 accept:false 不是"阶段 1 判负",是"阶段 1
		// 被打断",不升级。
		if (stopRequested) return abortedResult(fastResult);

		// 升级。阶段 1 的输出到此为止:不进 output、不进 answer、不进阶段 2 的 context。
		// `fast_path_escalated` 事件已由 FastPathRuntime 发过,payload 只带 `reason`。
		// `reason` 有 5 个 emit 点(`grep -n 'emit("fast_path_escalated"' fast-path-
		// runtime.ts`,逐一核对过),来源不止一种,泄漏面也不是同一个量级:
		//   - 限额/超时(checkPreempted):`describeTripped()` 拼配置数值(runTimeoutMs /
		//     maxCostUsd / maxTotalTokens),有界;
		//   - 检索无命中 / 一条正文都没取到:固定串;
		//   - 判负(judgeFastPathOutput 的 verdict.reason):可能内嵌阶段 1 输出里的
		//     clause_id / finish_reason / confidence 取值(judgeFastPathOutput 读的是
		//     `checked.detail`,不是带原文片段的 `checked.followUp`),不含条款正文、也不含
		//     完整答案 JSON;
		//   - 🔴 阶段 1 抛错且未撞限额/超时(runFast 的 catch 分支):`\`阶段 1 抛错:
		//     ${error.message}\``——**被捕获异常的 message,内容不受约束**。与
		//     `store/sqlite.ts` 的 `runs.error_message`(`TEXT`,按既有设计就存任意错误
		//     消息)同类,不是本组合子新开的口子。
		// 该事件在 trajectory.ts 的白名单里、会落库。
		full = await options.createFull();
		unsubscribeFull = full.subscribe(fanOut);
		// C-1(两阶段交界处):`stopRequested` 可能是在 `createFull()` 还没 resolve 时才被置位
		// 的——那次 `abort()` 调用当时转发给的是 `options.fast`(下面 `full` 那一刻还没赋值),
		// 对已经跑完的阶段 1 而言是 no-op,拦不住马上要发生的 `full.run()`。这里必须**再查一次**
		// stopRequested,不能假设上面那次检查已经够了:两次检查之间隔着 `await
		// options.createFull()` 这个真正的挂起点,cancel 完全可能在这段时间里到达。
		//
		// 查到就跳过 `full.run()`,不起 900s 的 agent 路径。`full.abort()` 这里仍然调
		// (吞掉失败)——与 run-manager.ts 的 admitAndDrive() 同一条纪律:run() 还没起步时调用
		// abort() 对 SessionRuntime 只是 no-op(没有正在跑的 prompt 可打断),调了不指望它真的
		// 拦住什么,只是记录取消意图、给将来行为不同的 Runtime 实现留一个一致的调用点。
		if (stopRequested) {
			await full.abort().catch(() => {});
			return abortedResult(fastResult);
		}
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
		// C-1:先记下"有人要求停"(这一层唯一能确定这件事的地方),再转发到**当前活跃**的那一段
		// ——阶段 2 建起来之后它才是在跑的那个。置标志再转发,与 run-manager.ts 的 cancel()
		// "置标志再 abort"同一条纪律。
		abort: () => {
			stopRequested = true;
			return (full ?? options.fast).abort();
		},
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
