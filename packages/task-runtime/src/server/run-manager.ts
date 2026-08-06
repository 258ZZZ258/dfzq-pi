import { randomUUID } from "node:crypto";
// 复用 trajectory.ts 的落盘白名单(与其导出复用的注释同一处道理):两套白名单会漂移。
import { shouldRecord } from "../observability/trajectory.ts";
import type { RunResult, Runtime, RuntimeEvent } from "../runtime/contract.ts";
import type { RunStore, StoredEvent, StoredRunStatus } from "../store/contract.ts";
// 新 submit() 直接判 admission.kind 三支,不再需要 isRejection(留着会是未使用导入,biome 报错)
import type { Gate, GateRejection, GateTicket } from "./gate.ts";
// 终态判据只应有一份定义(见 routes.ts 的 isTerminal 注释);这里不再自己维护第二份
// TERMINAL 白名单,避免两处未来各自漏改、方向还相反。
import { isTerminal } from "./routes.ts";

/**
 * 落库前的脱敏投影(task-18b 硬性约束,见 brief「必须脱敏」一节)。
 *
 * `tool_execution_end` 的原始 payload 带工具返回体(制度条款正文),`tool_execution_start`
 * 带调用参数(可能是检索词)—— 两者都不得落库。`StoredEvent.payload` 的契约注释明写「已
 * 序列化、已脱敏」(store/contract.ts:42-43),A6 要对账的是**调用序列**,不是调用内容。
 * 因此这里只从原始 payload 里摘 `toolName` / `isError` 两个字段(pi 的
 * ToolExecutionStartEvent/ToolExecutionEndEvent 都带 `toolName`,后者另带 `isError`;
 * `args`/`result` 一律不进投影),再拼上事件类型、seq、ts —— 与 brief 明列的白名单
 * (工具名 · isError · 事件类型 · seq · ts)逐项对应。
 */
function toStoredEvent(event: RuntimeEvent): StoredEvent {
	const raw = event.payload;
	const toolName =
		typeof raw === "object" && raw !== null && typeof (raw as { toolName?: unknown }).toolName === "string"
			? (raw as { toolName: string }).toolName
			: undefined;
	const isError =
		typeof raw === "object" && raw !== null && typeof (raw as { isError?: unknown }).isError === "boolean"
			? (raw as { isError: boolean }).isError
			: undefined;
	const sanitized: { type: string; seq: number; ts: number; toolName?: string; isError?: boolean } = {
		type: event.type,
		seq: event.seq,
		ts: event.ts,
	};
	if (toolName !== undefined) sanitized.toolName = toolName;
	if (isError !== undefined) sanitized.isError = isError;
	return { seq: event.seq, ts: event.ts, type: event.type, payload: JSON.stringify(sanitized) };
}

/**
 * Java jCasbin 预计算的授权位(设计文档 §6.4.1 的 `filters`)。**agent 不可见** ——
 * 它不出现在任何工具的 JSON Schema 里,由 MCP adapter 在 schema 之外注入(规格 §2.3)。
 */
export interface RunFilters {
	/**
	 * 可缺省,且**缺省与空数组同义**:「无额外限制」是边界契约的明文,不是 fail-open
	 * (audit-ai `query/query/api/routes_boundary.py:39-40` 原话)。这个默认语义属于消费端
	 * (C1 / MCP 注入点),不属于这一层 —— 本层在此补 `[]` 会把 filters_json 的存档改写成
	 * 与 Java 发来的请求体不同的东西,而那是事后审计授权范围的唯一凭证。
	 */
	permTags?: string[];
	corpusTypes: string[];
	projectId?: string | null;
	owner?: string | null;
}

/** 查询层选项,透传给下游 audit-ai。刻意不收窄:加字段不该变成一次 HTTP 层改动。 */
export interface RunOptions {
	topK?: number;
	includeSuperseded?: boolean;
}

export type RuntimeFactory = (input: {
	specId: string;
	sessionId: string;
	/**
	 * C1 的 per-run 白名单拿它当隔离键(规格 §3.3)。S3 按 specId 池化之后 MCP server
	 * 会跨 run 复用,靠进程隔离的白名单会串 run —— 两个并发 run 能互取对方的条款详情。
	 */
	runId: string;
	filters: RunFilters;
	options: RunOptions;
	/** 结构化任务输入,原样透传(不补默认值),见 SubmitRequest.payload 的注释。 */
	payload?: Record<string, unknown>;
}) => Promise<Runtime>;

export interface SubmitRequest {
	taskKind: string;
	specId: string;
	input: string;
	clientRequestId: string;
	requestId?: string;
	sessionId: string;
	/**
	 * 授权位。**结构化** —— stringify 归本类做。此前调用方传 filtersJson、本类原样存档,
	 * 于是 app.ts 与本类各持一份序列化职责;要把 filters 透给工厂就得在两处都解析回来。
	 */
	filters: RunFilters;
	options?: RunOptions;
	/**
	 * 结构化任务输入(如「制度比对」的外规 objectKey/uploadId/filename)。**结构化** ——
	 * stringify 归本类做,与 filters 同一条纪律,理由同上一条注释。可缺省:`policy-query`
	 * 等不需要结构化输入的 taskKind 不传,存档列随之缺省为 undefined,不补 "{}"。
	 */
	payload?: Record<string, unknown>;
}

export type SubmitOutcome =
	/**
	 * ⚠ queued 当前**无生产消费方**:app.ts 从不读这个字段,HTTP 层的 202 status 全部以
	 * store.findByRunId() 当场查到的行状态为准(见 app.ts 的 idempotent 分支与等待窗口
	 * 超时分支,两处都是 `row?.status ?? ...`)。留着不删是留给 S2 再决定;若日后真的想让
	 * app.ts 改读这个字段,先看清楚下面两支语义并不相同,不能互换:
	 *   - 去重分支(命中 live 注册表的同键并发/重试):此刻(读到这条 live 记录那一刻)
	 *     是否仍未装配 —— 是一个"现在"值,随时间推移会从 true 变 false。
	 *   - 正常分支(真正新建的 admission):**准入那一刻**是否走过排队路径 —— 是创建时的
	 *     历史快照,此后不再更新,即便这个 run 早就从排队转正在跑。
	 * 两者对同一个 runId 在不同时间点可能给出不同答案,别当成同一件事读。
	 */
	| { kind: "accepted"; runId: string; completion: Promise<RunResult>; queued: boolean }
	| { kind: "idempotent"; runId: string; status: StoredRunStatus }
	| { kind: "rejected"; rejection: GateRejection };

export type CancelOutcome = "accepted" | "not_found" | "already_terminal";

/**
 * 「制度比对」`compare_stage` 事件的载荷(规格 §7.2)。只服务 `GET /runs/{id}` 的进度展示,
 * **不落库** —— 长 run 都走 202 + 轮询,进度是「当下」状态,历史进度由 `run_events` 表自己
 * 承担;`RunManager` 只在内存里记最后一条,run 落终态即清掉(见 `progress` 字段与
 * `live.delete(runId)` 同处的清理)。`policy-query` 等不发 `compare_stage` 的 taskKind 从不
 * 写入这张表,`progressOf` 对它们恒返回 `undefined`,零影响。
 */
export interface RunProgress {
	stage: string;
	percent: number;
	current: number;
	total: number;
	message: string;
}

export interface RunManagerOptions {
	store: RunStore;
	gate: Gate;
	runtimeFactory: RuntimeFactory;
	now?: () => number;
	newRunId?: () => string;
}

/**
 * 内存注册表的一项。`runtime` 在排队期间为 undefined —— 那时还没装配。
 * `cancelRequested` 让「排队中被取消」不必依赖 Gate 的取消支持(Gate 没有)。
 */
interface LiveRun {
	completion: Promise<RunResult>;
	runtime?: Runtime;
	cancelRequested: boolean;
}

/**
 * run 生命周期的唯一所有者。
 *
 * 幂等与闸门刻意放在这里而不是中间件层(偏离设计文档 §5.2 的扁平链):幂等必须与 INSERT
 * 原子,闸门必须与内存注册表同生命周期。放在中间件层要重复持有 store,并把原子性拆开。
 *
 * 执行与响应解耦:submit() 返回的 completion promise 由本类持有并推进到底。HTTP 层只
 * race 它与等待窗口,超时回 202 后**不再碰它** —— 连接断开也不中断 run(设计文档 §6.4.2)。
 */
export class RunManager {
	private readonly store: RunStore;
	private readonly gate: Gate;
	private readonly runtimeFactory: RuntimeFactory;
	private readonly now: () => number;
	private readonly newRunId: () => string;
	private readonly live = new Map<string, LiveRun>();
	/** 见 RunProgress 的注释:只对在飞的 run 有意义,清理时机与 live 表同处。 */
	private readonly progress = new Map<string, RunProgress>();

	constructor(options: RunManagerOptions) {
		this.store = options.store;
		this.gate = options.gate;
		this.runtimeFactory = options.runtimeFactory;
		this.now = options.now ?? (() => Date.now());
		this.newRunId = options.newRunId ?? (() => randomUUID());
	}

	get activeRuns(): number {
		return this.gate.activeCount;
	}

	get queueDepth(): number {
		return this.gate.queueDepth;
	}

	/** `GET /runs/{id}` 非终态分支专用(规格 §7.2)。没收到过 compare_stage、或 run 已落
	 *  终态(见 progress 与 live.delete 同处的清理)时返回 undefined —— 调用方据此决定要不要
	 *  在响应体里挂 progress 字段。 */
	progressOf(runId: string): RunProgress | undefined {
		return this.progress.get(runId);
	}

	/**
	 * serve 侧事件落库(task-18b):A6 要求 pi 侧的工具调用事件流与 MCP 侧审计日志逐条
	 * 对得上,而这条链路此前从未接线 —— `appendEvents` 声明了、实现了,零调用点。
	 *
	 * 逐条写(不缓冲到 finish 批量写):每条白名单事件到达就立即调一次
	 * `store.appendEvents(runId, [...])`。取舍见任务报告,要点是——进程真崩溃(kill -9 /
	 * OOM)时,这个选择丢的只是"崩溃那一刻正在处理、还没来得及跑进这个回调"的那一条事件之前
	 * 的部分永远不丢;换成缓冲到 finish 才写,会让整个 run 的事件史随崩溃一次性清零,而 run
	 * 本身的终态行本来就可能因为同一次崩溃留在 running/queued(重启由 recoverStaleRuns 收尾)
	 * ——那种情况下逐条写至少留得下"崩溃前已经发生过什么"这份对账线索,批量写则什么都留不下。
	 *
	 * 落库失败(store 已 close / 磁盘满等)只记日志、不重新抛出 —— `Runtime.subscribe` 的
	 * fan-out(session-runtime.ts 对应位置)本身已经给每个监听器包了 try/catch、抛了也会继续
	 * 派发给其余监听器,所以这里不重新抛不是在补那一层的洞。这里的理由是本地的:不依赖上游
	 * fan-out 的保护、就近处理并打一条带 runId 的日志 —— 一条事件落库失败不该有牵连同一个
	 * run 上其余监听器、或者让调用方多一层要处理的异常这么大的影响面。
	 */
	private subscribeEvents(runId: string, runtime: Runtime): () => void {
		return runtime.subscribe((event) => {
			// 进度捕获与落库白名单分开判断:`compare_stage` 不在 shouldRecord 的 RECORDED_TYPES
			// 里(它是进度展示位,不是要审计的事件),必须在下面的 shouldRecord 短路之前处理,
			// 否则永远走不到这里。只记最后一条,不落库——RunProgress 的注释已经写清楚原因。
			if (event.type === "compare_stage") {
				this.progress.set(runId, event.payload as RunProgress);
			}
			if (!shouldRecord(event.type)) return;
			try {
				this.store.appendEvents(runId, [toStoredEvent(event)]);
			} catch (error) {
				console.error(`[RunManager] failed to persist event for run "${runId}"; this event is dropped`, error);
			}
		});
	}

	async submit(req: SubmitRequest): Promise<SubmitOutcome> {
		const runId = this.newRunId();
		const created = this.store.insertQueued({
			runId,
			clientRequestId: req.clientRequestId,
			requestId: req.requestId,
			specId: req.specId,
			taskKind: req.taskKind,
			sessionId: req.sessionId,
			filtersJson: JSON.stringify(req.filters),
			optionsJson: req.options ? JSON.stringify(req.options) : undefined,
			payloadJson: req.payload === undefined ? undefined : JSON.stringify(req.payload),
			input: req.input,
			createdAt: this.now(),
		});
		if (!created.inserted) {
			const existing = this.live.get(created.run.runId);
			// 同键并发:既有 run 还在跑就把同一个 promise 交出去,别让调用方以为已终态。
			if (existing) {
				// queued 必须读「此刻」的状态,不能是创建时的快照:命中这条分支的时机可以晚于
				// 准入判定任意久 —— 典型场景就是客户端超时后的重试。如果这里报的是创建时是否
				// 走过排队路径,一个「B 排队时进来、随后早就转正在跑」的重试会被误报成
				// queued:true,而 SubmitOutcome.queued 的唯一用途是让 HTTP 层决定 202 的
				// status 怎么报 —— 报错就会让已经在跑的 run 被客户端当成还没排上号。
				// entry.runtime 只在装配成功后才赋值,赋值前(不管是在排队还是在装配中)都
				// 应该算「此刻还没开始跑」。
				return {
					kind: "accepted",
					runId: created.run.runId,
					completion: existing.completion,
					queued: existing.runtime === undefined,
				};
			}
			return { kind: "idempotent", runId: created.run.runId, status: created.run.status };
		}

		// 会话忙 / 队满必须**同步**判定 —— HTTP 要立刻回 409 / 503。
		// 排队则**不阻塞 submit()**:把「等位 → 装配 → 推进 → 落库」整条链包成 promise 交出去,
		// HTTP 层用 waitMs 与它竞速,计时器先响就回 202。
		//
		// 这里刻意偏离设计文档 §4.1 的时序图(它把 acquire 画在 run 启动前、等待窗口之后)。
		// 按 §4.1 写的话,排在全局闸门后的请求会卡在 submit() 内、到不了 202 竞速点,客户端
		// 既拿不到 200 也拿不到 202 —— 与 §6.4.2「窗口超时即回 202」的承诺直接矛盾,且会造出
		// 「Java 读超时了但 run 还在跑」的孤儿(§10-2 警告的那个场景)。
		const admission = this.gate.tryAcquire(req.sessionId);
		if (admission.kind === "session_busy" || admission.kind === "queue_full") {
			// 拒绝时把 insertQueued 刚原子占下的幂等键还回去,而不是 markError 把行钉成终态。
			// 钉成终态会让"同一 clientRequestId 重试"命中 insertQueued 的 ON CONFLICT DO
			// NOTHING、拿到这行已死的 error 行,而不是真的重新尝试准入——瞬时限流因此变成
			// 永久任务丢失(设计裁定,见 finding #1)。
			//
			// 安全性依赖一个前提:insertQueued 与这里的 deleteRun 之间(以及中间的
			// tryAcquire)全程同步、没有 await——已核实 insertQueued(node:sqlite 的
			// DatabaseSync,同步 API)、tryAcquire(Gate 的同步准入判定)、deleteRun(同样是
			// DatabaseSync 同步 API)三者之间这段代码不含任何 await,Node 单线程不会在这里
			// 让出控制权,所以不存在"另一个同键请求在这行即将被删之间读到它"的窗口。
			this.store.deleteRun(runId);
			return { kind: "rejected", rejection: admission };
		}
		const ticketPromise = admission.kind === "admitted" ? Promise.resolve(admission.ticket) : admission.ticket;

		const queued = admission.kind === "queued";
		const entry: LiveRun = { completion: undefined as unknown as Promise<RunResult>, cancelRequested: false };
		this.live.set(runId, entry);
		entry.completion = this.admitAndDrive(runId, req, ticketPromise, entry);
		return { kind: "accepted", runId, completion: entry.completion, queued };
	}

	/** 等位 → 装配 → 推进 → 落库。整条链在后台跑到底,不因 HTTP 转 202 而中断。 */
	private async admitAndDrive(
		runId: string,
		req: SubmitRequest,
		ticketPromise: Promise<GateTicket>,
		entry: LiveRun,
	): Promise<RunResult> {
		const ticket = await ticketPromise;

		// 排队期间被 cancel:此时还没有 runtime 可 abort,直接放弃入场。
		// 不装配、不起 MCP 子进程 —— 省掉一次纯浪费的装配。
		if (entry.cancelRequested) return this.finishAsAborted(runId, req.specId, ticket);

		let runtime: Runtime;
		try {
			runtime = await this.runtimeFactory({
				specId: req.specId,
				sessionId: req.sessionId,
				runId,
				filters: req.filters,
				// 空对象而非 undefined:让下游解构 options.topK 时少一条判空分支。
				options: req.options ?? {},
				// 与 filters/options 不同:这里原样传 req.payload(可能是 undefined),不补 {} ——
				// 装配期的 parseCoveragePayload 等校验要能分清「没传 payload」与「传了空对象」。
				payload: req.payload,
			});
		} catch (error) {
			// 装配期失败要早、要响亮,且必须还回令牌 —— 否则一次装配失败永久占额。
			const message = error instanceof Error ? error.message : String(error);
			try {
				this.store.markError(runId, message, this.now());
			} catch (markErrorFailure) {
				// markError 本身也可能抛(磁盘满 / 优雅下线期间 store 已 close 等,见 drive()
				// 里同一条注释)。绝不能让这个次生错误盖过下面要 throw 的 error——那才是这个
				// run 真正装配失败的原因;也绝不能让它跳过下面的 live.delete/ticket.release,
				// 否则一次 markError 失败就会让闸门名额与会话位永久泄漏(finding #2)。
				console.error(
					`[RunManager] failed to mark run "${runId}" as error after assembly failed; the run row is left stale`,
					markErrorFailure,
				);
			}
			this.live.delete(runId);
			// 这一支在 subscribeEvents 建立之前就失败,progress 不可能有这个 runId 的条目——
			// 与 live.delete 同处删,保持两张表的清理时机一致,不留"万一以后顺序变了"的隐患。
			this.progress.delete(runId);
			ticket.release();
			throw error;
		}
		entry.runtime = runtime;
		// 接线点(task-18b):装配已成功、drive() 尚未开始。从这里往下有三条退出路径
		// (本分支的立即取消、下面 markRunning 失败、以及正常路径的 drive()),订阅建立之后
		// 的每一条都必须解得掉 —— 三条都已核实覆盖(task-18b 复审 Important-1 修复前,这一条
		// 分支里 finishAsAborted() 抛出时会跳过下面的 unsubscribeEvents()/dispose(),已用
		// try/finally 补上,不再依赖"顺序执行到最后一行"这个脆弱前提)。
		const unsubscribeEvents = this.subscribeEvents(runId, runtime);

		// 装配成功但 run() 还没起步时已被 cancel:runtime 建好了,但对 stub 和真实的
		// SessionRuntime 而言,run() 开始前调用 abort() 都只是 no-op(没有正在跑的 prompt
		// 可打断——stub 的 settle 还没挂上,SessionRuntime 的 session.abort() 同理无事可做)。
		// 若这里仍然继续走 drive()/run(),就会把一个「已取消」的 run 又启动一遍,对 stub
		// 而言直接挂死(自审时用 debug log 复现过这个 race:cancel() 恰好夹在「装配完成」
		// 和「markRunning 前」之间)。因此必须像排队分支一样,直接按已取消收尾、绝不调用 run()。
		if (entry.cancelRequested) {
			await runtime.abort().catch(() => {});
			// try/finally(task-18b 复审 Important-1):finishAsAborted() 在 store.finish()
			// 落库失败时会重抛(见该函数内部注释),重抛此前这里是三条顺序语句,一抛就会跳过
			// 下面的 unsubscribeEvents()/dispose() —— 悬空的订阅本身影响有限(run() 从未被
			// 调用,不会再收到事件,live.delete 之后 runtime 也可被 GC),但 dispose() 被跳过
			// 是真的漏:MCP 子进程不会被回收。finally 保证两者无条件执行。
			try {
				return await this.finishAsAborted(runId, req.specId, ticket);
			} finally {
				unsubscribeEvents();
				await runtime.dispose().catch(() => {});
			}
		}

		try {
			this.store.markRunning(runId, this.now());
		} catch (error) {
			// 与上面装配失败的分支同一条纪律:markRunning 落库失败(store 已 close / 磁盘满等)
			// 时,drive() 根本不会被调用,它自己的 finally 救不到这里——必须在这里自己补上
			// live.delete + ticket.release + dispose,否则一次 markRunning 失败就会让这个已经
			// 装配成功的 runtime 白白泄漏,且闸门名额与会话位永久钉住(finding #2)。这里没有
			// "次生 vs 原始"之分:markRunning 的失败本身就是要抛给调用方的那个错误。
			console.error(
				`[RunManager] failed to mark run "${runId}" as running; releasing the gate slot and abandoning this attempt`,
				error,
			);
			this.live.delete(runId);
			this.progress.delete(runId);
			ticket.release();
			unsubscribeEvents();
			await runtime.dispose().catch(() => {});
			throw error;
		}
		return this.drive(runId, runtime, req.input, ticket, unsubscribeEvents);
	}

	/** 排队中 / 装配后 run() 尚未起步即被取消的共同收尾:直接落库为 aborted,不调用 run()。 */
	private async finishAsAborted(runId: string, specId: string, ticket: GateTicket): Promise<RunResult> {
		const result: RunResult = {
			runId,
			specId,
			status: "aborted",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
			turns: 0,
			durationMs: 0,
			judgeAttempts: {},
		};
		try {
			this.store.finish(runId, result, this.now());
		} catch (error) {
			// 同上:finish() 落库失败不能让下面的 live.delete/ticket.release 被跳过——
			// finally 保证两者无条件执行,catch 只负责记日志、原样把错误抛给调用方
			// (finishAsAborted 没有独立于这次落库的"原始错误"可言,这次落库失败本身就是)。
			console.error(
				`[RunManager] failed to persist aborted result for run "${runId}"; the run row is left stale`,
				error,
			);
			throw error;
		} finally {
			this.live.delete(runId);
			this.progress.delete(runId);
			ticket.release();
		}
		return result;
	}

	private async drive(
		runId: string,
		runtime: Runtime,
		input: string,
		ticket: GateTicket,
		unsubscribeEvents: () => void,
	): Promise<RunResult> {
		try {
			const result = await runtime.run(input, { runId });
			this.store.finish(runId, result, this.now());
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this.store.markError(runId, message, this.now());
			} catch (markErrorFailure) {
				// markError 自身也可能抛(典型场景:进程正在优雅下线,store 已经 close()
				// 过)。这里不能让它盖过下面要 throw 的原始 error ——原始 error 才是这个 run
				// 真正失败的原因;但也绝不能无声吞掉:不然这一行会永久停在 running/queued
				// 态,且没有任何日志能解释为什么(见 server/main.ts 的 close() 同一条纪律)。
				console.error(
					`[RunManager] failed to mark run "${runId}" as error after it failed; the run row is left stale`,
					markErrorFailure,
				);
			}
			throw error;
		} finally {
			// 结果已落盘 → 可立即驱逐 runtime(设计文档 §4.1)。解订阅放在这里(task-18b):
			// 与 live.delete / ticket.release 同一处收尾,run() 正常返回、抛错两条路径都
			// 无条件走到这里,确保事件订阅不会在 runtime 被驱逐之后继续悬空。
			//
			// progress.delete 同处清理(Task 11):这是「制度比对」在飞的 run 真正会走到的路径
			// ——compare_stage 只在 runtime.run() 执行期间才可能发出,run 落终态(不管成功/
			// limit_exceeded/error)后进度就该消失,不然一个已结束 run 的旧进度会被后来的
			// GET /runs/{id} 查询读到。
			this.live.delete(runId);
			this.progress.delete(runId);
			ticket.release();
			unsubscribeEvents();
			await runtime.dispose().catch(() => {});
		}
	}

	async cancel(runId: string): Promise<CancelOutcome> {
		const entry = this.live.get(runId);
		if (entry) {
			// 置标志再 abort:排队中的 run 还没有 runtime,标志让 admitAndDrive 在拿到票后
			// 直接放弃入场。已在跑的 run 两条都生效(abort 立即起作用)。
			entry.cancelRequested = true;
			if (entry.runtime) {
				// cancelRequested 在 abort() 之前已经置位 —— 取消意图已经记下了。真实的
				// SessionRuntime.abort() 可能抛(stub 不会),抛错不能让 cancel() 返回的
				// Promise<CancelOutcome> 变成 reject —— HTTP 层的契约是 202/404/409 三态
				// 之一,不是 500。吞掉、打一行日志,仍报 "accepted":202 本来就只承诺
				// 「取消请求已受理」,不保证 runtime 已经真正停下。
				await entry.runtime.abort().catch((error: unknown) => {
					console.error(
						`[RunManager] abort() failed for run "${runId}"; cancellation intent already recorded`,
						error,
					);
				});
			}
			return "accepted";
		}
		const row = this.store.findByRunId(runId);
		if (!row) return "not_found";
		return isTerminal(row.status) ? "already_terminal" : "not_found";
	}
}
