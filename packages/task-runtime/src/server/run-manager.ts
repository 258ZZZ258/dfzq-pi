import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { authorize, type Grant, grantScopeHash, type Principal } from "../auth/grant.ts";
import { GrantLease } from "../auth/lease.ts";
import type { Conversation, InboxMessage, MessageInput, SessionInbox } from "../interaction/inbox.ts";
import type { MemoryScope } from "../memory/service.ts";
// 复用 trajectory.ts 的落盘白名单(与其导出复用的注释同一处道理):两套白名单会漂移。
import { shouldRecord } from "../observability/trajectory.ts";
import type { SessionCheckpoint } from "../runtime/checkpoint.ts";
import type { RunResult, Runtime, RuntimeEvent } from "../runtime/contract.ts";
import { sealDelivery } from "../runtime/delivery.ts";
import { hashState } from "../state/json.ts";
import type { RunRecord, RunStore, StoredEvent, StoredRunStatus } from "../store/contract.ts";
// 新 submit() 直接判 admission.kind 三支,不再需要 isRejection(留着会是未使用导入,biome 报错)
import { type Gate, GateCancelledError, type GateRejection, type GateTicket } from "./gate.ts";
import type { ResultValidator } from "./output-delivery.ts";
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
	const sanitized: Record<string, string | number | boolean> = {
		type: event.type,
		seq: event.seq,
		ts: event.ts,
	};
	if (toolName !== undefined) sanitized.toolName = toolName;
	if (isError !== undefined) sanitized.isError = isError;
	if (raw && typeof raw === "object") {
		const data = raw as Record<string, unknown>;
		if (typeof data.toolCallId === "string" && data.toolCallId.length <= 256) sanitized.toolCallId = data.toolCallId;
		for (const key of ["checkpointSeq", "fence"] as const)
			if (typeof data[key] === "number" && Number.isSafeInteger(data[key]) && data[key] >= 0)
				sanitized[key] = data[key];
		if (typeof data.next === "string" && ["pending_tools", "continue", "judge", "repair"].includes(data.next))
			sanitized.next = data.next;
		if (
			typeof data.reason === "string" &&
			[
				"worker_cancelled",
				"worker_timeout",
				"worker_disposed",
				"worker_exited",
				"worker_transport_failed",
				"worker_protocol_error",
				"assembly_timeout",
			].includes(data.reason)
		)
			sanitized.reason = data.reason;
		const result = data.result as { details?: { ledgerReplay?: unknown } } | undefined;
		if (data.replayed === true || result?.details?.ledgerReplay === true) sanitized.replayed = true;
	}
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
	durableSession?: boolean;
	messageId?: string;
	interaction?: boolean;
	conversation?: Conversation;
	authorization?: Grant;
	memoryScope?: MemoryScope;
	/** Host-controlled continuation reference; persisted for audit/replay. */
	resumeFrom?: string;
	topK?: number;
	includeSuperseded?: boolean;
	reportTaskId?: string;
	reportType?: "consultation" | "regular" | "turnover";
}

export type RuntimeFactory = ((input: {
	initialInput?: string;
	operationRunId?: string;
	resume?: SessionCheckpoint;
	onCheckpoint?: (checkpoint: SessionCheckpoint) => Promise<void>;
	/** Construction cancellation; never serialized into the request record. */
	signal?: AbortSignal;
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
}) => Promise<Runtime>) & {
	supportsResume?: true;
	registerPending?: (runId: string) => Promise<void>;
	unregisterPending?: (runId: string) => Promise<void>;
	isRunActive?: (row: RunRecord) => Promise<boolean>;
	close?: () => Promise<void>;
};

export interface SubmitRequest {
	principal?: Principal;
	taskKind: string;
	specId: string;
	input: string;
	clientRequestId: string;
	requestId?: string;
	sessionId: string;
	/** False only when the HTTP boundary generated a new session ID for an omitted field. */
	sessionIdExplicit?: boolean;
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
	| { kind: "idempotency_conflict" }
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
	inbox?: SessionInbox;
	validateResult?: ResultValidator;
	store: RunStore<boolean>;
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
	assemblyAbort: AbortController;
	completion: Promise<RunResult>;
	runtime?: Runtime;
	cancelRequested: boolean;
	cancelQueued?: () => boolean;
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
	private readonly inbox?: SessionInbox;
	private readonly dispatcherId = randomUUID();
	private inboxTimer?: NodeJS.Timeout;
	private dispatching?: Promise<void>;
	private inboxCursor = "";
	private closing = false;
	private readonly validateResult: ResultValidator;
	private readonly store: RunStore<boolean>;
	private readonly gate: Gate;
	private readonly runtimeFactory: RuntimeFactory;
	private readonly now: () => number;
	private readonly newRunId: () => string;
	private readonly live = new Map<string, LiveRun>();
	// Serialize only admission/rollback, not execution. This is process-local;
	// multi-replica admission still requires a shared transactional coordinator.
	private readonly submissions = new Map<string, Promise<SubmitOutcome>>();
	/** 见 RunProgress 的注释:只对在飞的 run 有意义,清理时机与 live 表同处。 */
	private readonly progress = new Map<string, RunProgress>();

	constructor(options: RunManagerOptions) {
		this.inbox = options.inbox;
		this.validateResult = options.validateResult ?? ((result) => sealDelivery(result, "not_checked"));
		this.store = options.store;
		this.gate = options.gate;
		this.runtimeFactory = options.runtimeFactory;
		this.now = options.now ?? (() => Date.now());
		this.newRunId = options.newRunId ?? (() => randomUUID());
		if (this.inbox)
			this.inboxTimer = setInterval(() => {
				void this.dispatchFollowUps().catch((error) => console.error("[RunManager] inbox dispatch failed", error));
			}, 500);
	}

	get activeRuns(): number {
		return this.gate.activeCount;
	}
	get supportsMessages(): boolean {
		return Boolean(this.inbox);
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

	/** Persist sanitized events as they arrive, with at most 1024 in-flight writes.
	 * Stop the run on storage failure; drain before publishing a terminal result.
	 * Process death can still lose unacknowledged events, so these are not checkpoints.
	 */
	private subscribeEvents(runId: string, runtime: Runtime): () => Promise<void> {
		const pending = new Set<Promise<void>>();
		let failure: Error | undefined;
		const fail = (cause: unknown) => {
			if (failure) return;
			failure = new Error("event_persistence_failed", { cause });
			void runtime.abort().catch(() => {});
		};
		const unsubscribe = runtime.subscribe((event) => {
			// 进度捕获与落库白名单分开判断:`compare_stage` 不在 shouldRecord 的 RECORDED_TYPES
			// 里(它是进度展示位,不是要审计的事件),必须在下面的 shouldRecord 短路之前处理,
			// 否则永远走不到这里。只记最后一条,不落库——RunProgress 的注释已经写清楚原因。
			if (event.type === "compare_stage") {
				this.progress.set(runId, event.payload as RunProgress);
			}
			if (!shouldRecord(event.type)) return;
			if (failure) return;
			if (pending.size >= 1024) {
				fail(new Error("event_queue_full"));
				return;
			}
			try {
				const write = Promise.resolve(this.store.appendEvents(runId, [toStoredEvent(event)])).catch(fail);
				pending.add(write);
				void write.finally(() => pending.delete(write));
			} catch (error) {
				fail(error);
			}
		});
		return async () => {
			unsubscribe();
			await Promise.all(pending);
			if (failure) throw failure;
		};
	}

	async submit(req: SubmitRequest): Promise<SubmitOutcome> {
		if (this.closing) return { kind: "rejected", rejection: { kind: "queue_full", retryAfterSeconds: 5 } };
		const submissionKey = req.principal
			? hashState([req.principal.tenantId, req.principal.userId, req.clientRequestId])
			: req.clientRequestId;
		const previous = this.submissions.get(submissionKey);
		if (previous) {
			await previous.catch(() => {});
			return this.submit(req);
		}
		const pending = this.submitOnce(req);
		this.submissions.set(submissionKey, pending);
		try {
			return await pending;
		} finally {
			if (this.submissions.get(submissionKey) === pending) this.submissions.delete(submissionKey);
		}
	}
	private comparableOptions(options: RunOptions): unknown {
		const { authorization, ...rest } = options;
		return { ...rest, ...(authorization ? { authorizationScope: grantScopeHash(authorization) } : {}) };
	}

	private async submitOnce(req: SubmitRequest): Promise<SubmitOutcome> {
		const runId = this.newRunId();
		const created = await this.store.insertQueued({
			principalJson: req.principal ? JSON.stringify(req.principal) : undefined,
			runId,
			sessionIdExplicit: req.sessionIdExplicit !== false,
			clientRequestId: req.principal
				? hashState([req.principal.tenantId, req.principal.userId, req.clientRequestId])
				: req.clientRequestId,
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
			const row = created.run;
			if (
				!isDeepStrictEqual(row.principalJson ? JSON.parse(row.principalJson) : undefined, req.principal) ||
				row.taskKind !== req.taskKind ||
				row.specId !== req.specId ||
				row.input !== req.input ||
				(row.sessionIdExplicit ?? true) !== (req.sessionIdExplicit !== false) ||
				(req.sessionIdExplicit !== false && row.sessionId !== req.sessionId) ||
				!isDeepStrictEqual(JSON.parse(row.filtersJson), JSON.parse(JSON.stringify(req.filters))) ||
				!isDeepStrictEqual(
					this.comparableOptions(JSON.parse(row.optionsJson ?? "{}") as RunOptions),
					this.comparableOptions(req.options ?? {}),
				) ||
				!isDeepStrictEqual(row.payloadJson === undefined ? undefined : JSON.parse(row.payloadJson), req.payload)
			) {
				return { kind: "idempotency_conflict" };
			}
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
		const admission = this.gate.tryAcquire(
			req.principal ? hashState([req.principal.tenantId, req.principal.userId, req.sessionId]) : req.sessionId,
		);
		if (admission.kind === "session_busy" || admission.kind === "queue_full") {
			// 拒绝时把 insertQueued 刚原子占下的幂等键还回去,而不是 markError 把行钉成终态。
			// 钉成终态会让"同一 clientRequestId 重试"命中 insertQueued 的 ON CONFLICT DO
			// NOTHING、拿到这行已死的 error 行,而不是真的重新尝试准入——瞬时限流因此变成
			// 永久任务丢失(设计裁定,见 finding #1)。
			//
			// submit() keeps same-key retries outside this asynchronous rollback
			// window. Do not assume PostgreSQL operations are synchronous.
			await this.store.deleteRun(runId);
			return { kind: "rejected", rejection: admission };
		}
		const ticketPromise = admission.kind === "admitted" ? Promise.resolve(admission.ticket) : admission.ticket;
		try {
			await this.runtimeFactory.registerPending?.(runId);
			if (this.inbox && req.options?.authorization && req.options.interaction) {
				const prior = (await this.inbox.state(req.options.authorization))?.active;
				const previous = prior ? await this.findRun(prior.runId) : undefined;
				await this.inbox.begin(
					req.options.authorization,
					runId,
					req.options.resumeFrom ?? runId,
					previous && isTerminal(previous.status) ? previous.runId : undefined,
				);
			}
		} catch (error) {
			if (admission.kind === "admitted") admission.ticket.release();
			else {
				void admission.ticket.catch(() => {});
				admission.cancel();
			}
			await this.runtimeFactory.unregisterPending?.(runId).catch(() => {});
			await this.store.deleteRun(runId);
			throw error;
		}

		const queued = admission.kind === "queued";
		const entry: LiveRun = {
			assemblyAbort: new AbortController(),
			completion: undefined as unknown as Promise<RunResult>,
			cancelRequested: false,
			cancelQueued: admission.kind === "queued" ? admission.cancel : undefined,
		};
		this.live.set(runId, entry);
		entry.completion = this.admitAndDrive(runId, req, ticketPromise, entry);
		entry.completion = entry.completion.finally(async () => {
			await this.runtimeFactory.unregisterPending?.(runId);
			if (this.inbox && req.options?.authorization && req.options.interaction) {
				const row = await this.store.findByRunId(runId);
				await this.inbox.finish(req.options.authorization, runId, row?.status ?? "error");
			}
		});
		void entry.completion.catch(() => {});
		return { kind: "accepted", runId, completion: entry.completion, queued };
	}

	/** 等位 → 装配 → 推进 → 落库。整条链在后台跑到底,不因 HTTP 转 202 而中断。 */
	private async admitAndDrive(
		runId: string,
		req: SubmitRequest,
		ticketPromise: Promise<GateTicket>,
		entry: LiveRun,
	): Promise<RunResult> {
		let ticket: GateTicket;
		try {
			ticket = await ticketPromise;
		} catch (error) {
			if (error instanceof GateCancelledError) return this.finishAsAborted(runId, req.specId);
			throw error;
		}
		entry.cancelQueued = undefined;

		// 排队期间被 cancel:此时还没有 runtime 可 abort,直接放弃入场。
		// 不装配、不起 MCP 子进程 —— 省掉一次纯浪费的装配。
		if (entry.cancelRequested) return this.finishAsAborted(runId, req.specId, ticket);

		let runtime: Runtime;
		try {
			runtime = await this.runtimeFactory({
				initialInput: req.input,
				signal: entry.assemblyAbort.signal,
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
			if (entry.cancelRequested) return this.finishAsAborted(runId, req.specId, ticket);
			const message = error instanceof Error ? error.message : String(error);
			try {
				await this.store.markError(runId, message, this.now());
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
		const finishCancelledBeforeRun = async (): Promise<RunResult> => {
			await runtime.abort().catch(() => {});
			// try/finally(task-18b 复审 Important-1):finishAsAborted() 在 store.finish()
			// 落库失败时会重抛(见该函数内部注释),重抛此前这里是三条顺序语句,一抛就会跳过
			// 下面的 unsubscribeEvents()/dispose() —— 悬空的订阅本身影响有限(run() 从未被
			// 调用,不会再收到事件,live.delete 之后 runtime 也可被 GC),但 dispose() 被跳过
			// 是真的漏:MCP 子进程不会被回收。finally 保证两者无条件执行。
			try {
				return await this.finishAsAborted(runId, req.specId, ticket);
			} finally {
				await unsubscribeEvents().catch(() => {});
				await runtime.dispose().catch(() => {});
			}
		};
		if (entry.cancelRequested) return finishCancelledBeforeRun();

		try {
			await this.store.markRunning(runId, this.now());
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
			await unsubscribeEvents().catch(() => {});
			await runtime.dispose().catch(() => {});
			throw error;
		}
		// markRunning is an async store operation. Cancellation can arrive after
		// the first check but before it resolves; do not start a fresh runtime then.
		if (entry.cancelRequested) return finishCancelledBeforeRun();
		return this.drive(
			runId,
			runtime,
			req.input,
			ticket,
			unsubscribeEvents,
			req.specId,
			req.options?.interaction ? req.options.authorization : undefined,
		);
	}

	/** 排队中 / 装配后 run() 尚未起步即被取消的共同收尾:直接落库为 aborted,不调用 run()。 */
	private async finishAsAborted(runId: string, specId: string, ticket?: GateTicket): Promise<RunResult> {
		const result: RunResult = sealDelivery(
			{
				runId,
				specId,
				status: "aborted",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
				turns: 0,
				durationMs: 0,
				judgeAttempts: {},
			},
			"not_checked",
		);
		try {
			await this.store.finish(runId, result, this.now());
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
			ticket?.release();
		}
		return result;
	}

	private async drive(
		runId: string,
		runtime: Runtime,
		input: string,
		ticket: GateTicket,
		unsubscribeEvents: () => Promise<void>,
		specId: string,
		authorization?: Grant,
	): Promise<RunResult> {
		try {
			const result = this.validateResult(await runtime.run(input, { runId }), { runId, specId });
			if (authorization && this.inbox && result.status === "completed") {
				if (!runtime.getConversation) throw new Error("conversation_not_supported");
				await this.inbox.stageConversation(authorization, runId, await runtime.getConversation());
			}
			await unsubscribeEvents();
			await this.store.finish(runId, result, this.now());
			await runtime.confirmResultStored?.(result);
			return result;
		} catch (error) {
			await unsubscribeEvents().catch(() => {});
			const message = error instanceof Error ? error.message : String(error);
			try {
				await this.store.markError(runId, message, this.now());
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
			await unsubscribeEvents().catch(() => {});
			await runtime.dispose().catch(() => {});
		}
	}

	async findRun(runId: string): Promise<RunRecord | undefined> {
		const row = await this.store.findByRunId(runId);
		if (
			row &&
			!isTerminal(row.status) &&
			!this.live.has(runId) &&
			this.runtimeFactory.isRunActive &&
			!(await this.runtimeFactory.isRunActive(row))
		) {
			await this.store.markStale?.(runId, "process_interrupted", this.now());
			return this.store.findByRunId(runId);
		}
		return row;
	}
	async shutdown(): Promise<void> {
		this.closing = true;
		if (this.inboxTimer) clearInterval(this.inboxTimer);
		await this.dispatching?.catch(() => {});
		await Promise.allSettled([...this.submissions.values()]);
		const entries = [...this.live.entries()];
		await Promise.allSettled(entries.map(([id]) => this.cancel(id)));
		await Promise.allSettled(entries.map(([, entry]) => entry.completion));
		await this.runtimeFactory.close?.();
	}
	async enqueueMessage(grant: Grant, input: MessageInput): Promise<InboxMessage> {
		if (!this.inbox) throw new Error("messages_not_configured");
		const row = await this.findRun(input.targetRunId ?? input.afterRunId ?? "");
		if (!row?.principalJson) throw new Error("run_not_found");
		authorize(grant, input.kind === "steer" ? "run:steer" : "run:follow_up", {
			sessionId: row.sessionId,
			taskKind: row.taskKind,
			principal: JSON.parse(row.principalJson) as Principal,
		});
		const options = JSON.parse(row.optionsJson ?? "{}") as RunOptions;
		if (
			!options.interaction ||
			!options.authorization ||
			grantScopeHash(options.authorization) !== grantScopeHash(grant)
		)
			throw new Error("message_scope_incompatible");
		return this.inbox.enqueue(grant, input);
	}
	async updateAuthorization(runId: string, grant: Grant, revoke = false): Promise<void> {
		if (!this.inbox) throw new Error("authorization_lease_not_configured");
		const row = await this.findRun(runId);
		if (!row?.principalJson) throw new Error("run_not_found");
		authorize(grant, revoke ? "run:cancel" : "run:renew", {
			sessionId: row.sessionId,
			taskKind: row.taskKind,
			principal: JSON.parse(row.principalJson) as Principal,
		});
		const options = JSON.parse(row.optionsJson ?? "{}") as RunOptions;
		if (!options.authorization) throw new Error("authorization_lease_missing");
		const lease = new GrantLease(this.inbox.store),
			root = options.resumeFrom ?? runId;
		if (revoke) {
			await lease.revoke(root, options.authorization);
			await this.cancel(runId);
		} else {
			if (grantScopeHash(options.authorization) !== grantScopeHash(grant))
				throw new Error("authorization_scope_changed");
			await lease.renew(root, grant);
		}
	}
	async listMessages(grant: Grant): Promise<InboxMessage[]> {
		if (!this.inbox) throw new Error("messages_not_configured");
		authorize(grant, "run:read", { sessionId: grant.sessionId });
		return this.inbox.messages(grant);
	}
	private dispatchFollowUps(): Promise<void> {
		if (this.dispatching) return this.dispatching;
		this.dispatching = this.dispatchBatch().finally(() => {
			this.dispatching = undefined;
		});
		return this.dispatching;
	}
	private async dispatchBatch(): Promise<void> {
		if (!this.inbox || this.closing) return;
		const sessions = await this.inbox.scan(this.inboxCursor);
		this.inboxCursor = sessions.length === 100 ? sessions[sessions.length - 1].key : "";
		for (const session of sessions) {
			if (this.closing) break;
			const state = await this.inbox.state(session.grant);
			if (state?.active && !this.live.has(state.active.runId)) {
				const row = await this.findRun(state.active.runId);
				if (row && isTerminal(row.status)) await this.inbox.finish(session.grant, row.runId, row.status);
			}
			const message = await this.inbox.claimFollowUp(session.grant, this.dispatcherId);
			if (!message) continue;
			try {
				const parent = await this.findRun(message.afterRunId!);
				if (!parent?.principalJson) throw new Error("run_not_found");
				authorize(message.grant, "run:follow_up", {
					sessionId: parent.sessionId,
					taskKind: parent.taskKind,
					principal: JSON.parse(parent.principalJson) as Principal,
				});
				const {
					resumeFrom: _resumeFrom,
					conversation: _conversation,
					messageId: _messageId,
					...options
				} = JSON.parse(parent.optionsJson ?? "{}") as RunOptions;
				const outcome = await this.submit({
					taskKind: parent.taskKind,
					specId: parent.specId,
					input: message.text,
					clientRequestId: `follow-up:${message.messageId}`,
					sessionId: parent.sessionId,
					sessionIdExplicit: true,
					principal: JSON.parse(parent.principalJson) as Principal,
					filters: JSON.parse(parent.filtersJson) as RunFilters,
					options: {
						...options,
						authorization: message.grant,
						interaction: true,
						conversation: message.conversation,
						messageId: message.messageId,
					},
				});
				if (outcome.kind === "accepted" || outcome.kind === "idempotent")
					await this.inbox.dispatched(message.grant, message.messageId, this.dispatcherId, outcome.runId);
				else
					await this.inbox.dispatched(
						message.grant,
						message.messageId,
						this.dispatcherId,
						undefined,
						outcome.kind === "rejected" ? outcome.rejection.kind : outcome.kind,
					);
			} catch (error) {
				await this.inbox.dispatched(
					message.grant,
					message.messageId,
					this.dispatcherId,
					undefined,
					error instanceof Error ? error.message : "dispatch_failed",
				);
			}
		}
	}
	async resume(
		runId: string,
		clientRequestId: string,
		authorization?: Grant,
	): Promise<SubmitOutcome | { kind: "not_found" } | { kind: "not_resumable" }> {
		if (!this.runtimeFactory.supportsResume) return { kind: "not_resumable" };
		const row = await this.findRun(runId);
		if (!row) return { kind: "not_found" };
		if (row.status === "completed") return { kind: "not_resumable" };
		const options = JSON.parse(row.optionsJson ?? "{}") as RunOptions;
		if (options.durableSession === false) return { kind: "not_resumable" };
		if (
			options.authorization &&
			(!authorization || grantScopeHash(options.authorization) !== grantScopeHash(authorization))
		)
			return { kind: "not_resumable" };
		return this.submit({
			principal: row.principalJson ? (JSON.parse(row.principalJson) as Principal) : undefined,
			taskKind: row.taskKind,
			specId: row.specId,
			sessionId: row.sessionId,
			sessionIdExplicit: true,
			clientRequestId,
			input: row.input,
			filters: JSON.parse(row.filtersJson) as RunFilters,
			options: {
				...options,
				...(authorization ? { authorization } : {}),
				resumeFrom: options.resumeFrom ?? row.runId,
			},
			payload: row.payloadJson ? (JSON.parse(row.payloadJson) as Record<string, unknown>) : undefined,
		});
	}

	async cancel(runId: string): Promise<CancelOutcome> {
		const entry = this.live.get(runId);
		if (entry) {
			// 置标志再 abort:排队中的 run 还没有 runtime,标志让 admitAndDrive 在拿到票后
			// 直接放弃入场。已在跑的 run 两条都生效(abort 立即起作用)。
			entry.cancelRequested = true;
			entry.assemblyAbort.abort(new Error("assembly_cancelled"));
			if (entry.cancelQueued?.()) {
				await entry.completion.catch((error: unknown) => {
					console.error(`[RunManager] queued cancellation could not be persisted for "${runId}"`, error);
				});
				return "accepted";
			}
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
		const row = await this.store.findByRunId(runId);
		if (!row) return "not_found";
		return isTerminal(row.status) ? "already_terminal" : "not_found";
	}
}
