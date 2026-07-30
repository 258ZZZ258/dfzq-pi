import { randomUUID } from "node:crypto";
import type { RunResult, Runtime } from "../runtime/contract.ts";
import type { RunStore, StoredRunStatus } from "../store/contract.ts";
// 新 submit() 直接判 admission.kind 三支,不再需要 isRejection(留着会是未使用导入,biome 报错)
import type { Gate, GateRejection, GateTicket } from "./gate.ts";

export type RuntimeFactory = (input: { specId: string; sessionId: string }) => Promise<Runtime>;

export interface SubmitRequest {
	taskKind: string;
	specId: string;
	input: string;
	clientRequestId: string;
	requestId?: string;
	sessionId: string;
	/** 原样存档的授权位,本层不解析。 */
	filtersJson: string;
	optionsJson?: string;
}

export type SubmitOutcome =
	/** queued=true 表示还在等全局闸门放行,尚未装配 —— HTTP 层据此把 202 的 status 报成 "queued"。 */
	| { kind: "accepted"; runId: string; completion: Promise<RunResult>; queued: boolean }
	| { kind: "idempotent"; runId: string; status: StoredRunStatus }
	| { kind: "rejected"; rejection: GateRejection };

export type CancelOutcome = "accepted" | "not_found" | "already_terminal";

export interface RunManagerOptions {
	store: RunStore;
	gate: Gate;
	runtimeFactory: RuntimeFactory;
	now?: () => number;
	newRunId?: () => string;
}

const TERMINAL: ReadonlySet<StoredRunStatus> = new Set(["completed", "aborted", "limit_exceeded", "error"]);

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

	async submit(req: SubmitRequest): Promise<SubmitOutcome> {
		const runId = this.newRunId();
		const created = this.store.insertQueued({
			runId,
			clientRequestId: req.clientRequestId,
			requestId: req.requestId,
			specId: req.specId,
			taskKind: req.taskKind,
			sessionId: req.sessionId,
			filtersJson: req.filtersJson,
			optionsJson: req.optionsJson,
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
			this.store.markError(runId, `rejected: ${admission.kind}`, this.now());
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
			runtime = await this.runtimeFactory({ specId: req.specId, sessionId: req.sessionId });
		} catch (error) {
			// 装配期失败要早、要响亮,且必须还回令牌 —— 否则一次装配失败永久占额。
			const message = error instanceof Error ? error.message : String(error);
			this.store.markError(runId, message, this.now());
			this.live.delete(runId);
			ticket.release();
			throw error;
		}
		entry.runtime = runtime;

		// 装配成功但 run() 还没起步时已被 cancel:runtime 建好了,但对 stub 和真实的
		// SessionRuntime 而言,run() 开始前调用 abort() 都只是 no-op(没有正在跑的 prompt
		// 可打断——stub 的 settle 还没挂上,SessionRuntime 的 session.abort() 同理无事可做)。
		// 若这里仍然继续走 drive()/run(),就会把一个「已取消」的 run 又启动一遍,对 stub
		// 而言直接挂死(自审时用 debug log 复现过这个 race:cancel() 恰好夹在「装配完成」
		// 和「markRunning 前」之间)。因此必须像排队分支一样,直接按已取消收尾、绝不调用 run()。
		if (entry.cancelRequested) {
			await runtime.abort().catch(() => {});
			const result = await this.finishAsAborted(runId, req.specId, ticket);
			await runtime.dispose().catch(() => {});
			return result;
		}

		this.store.markRunning(runId, this.now());
		return this.drive(runId, runtime, req.input, ticket);
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
		};
		this.store.finish(runId, result, this.now());
		this.live.delete(runId);
		ticket.release();
		return result;
	}

	private async drive(runId: string, runtime: Runtime, input: string, ticket: GateTicket): Promise<RunResult> {
		try {
			const result = await runtime.run(input, { runId });
			this.store.finish(runId, result, this.now());
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.markError(runId, message, this.now());
			throw error;
		} finally {
			// 结果已落盘 → 可立即驱逐 runtime(设计文档 §4.1)。
			this.live.delete(runId);
			ticket.release();
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
		return TERMINAL.has(row.status) ? "already_terminal" : "not_found";
	}
}
