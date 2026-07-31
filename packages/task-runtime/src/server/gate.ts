/**
 * 两级闸门(设计文档 §5.3)。pi 零限流,且 D8(无 SSE)意味着 Java 感知不到服务繁忙。
 *
 * 会话级恒为 1 不是产能策略而是**内核约束**:AgentSession 不支持并发 prompt(),
 * 同一会话被并发驱动会撞坏状态。
 *
 * ⚠ maxConcurrent 默认 4 / maxQueueDepth 默认 16 / retryAfterSeconds 默认 5 是**临时值**。
 * 风险 1(单会话内存无界)未经测量,S1b 拿到内存曲线、S3 做校准之前不放大(设计文档 §10-5)。
 *
 * 设计裁定(补丁,原 §4.1/§6.4.2 有矛盾):等待窗口从请求到达就开始计时,「等位 → 装配 →
 * 推进」整条链与 waitMs 竞速,计时器先响就回 202。这要求调用方(RunManager)能在不 await
 * 的情况下同步分辨「立即被拒(会话忙/队满)」与「需要排队等待」——前者要立刻变成 409/503,
 * 后者不该阻塞调用方。为此提供同步的 tryAcquire;既有的 acquire 保留为其薄包装,两者共用
 * 同一套判定逻辑,不重复实现。
 */

export type GateRejection = { kind: "session_busy" } | { kind: "queue_full"; retryAfterSeconds: number };

export interface GateTicket {
	release: () => void;
}

export interface GateOptions {
	maxConcurrent?: number;
	maxQueueDepth?: number;
	retryAfterSeconds?: number;
}

/**
 * 同步准入结果(设计裁定,见文件头注释「等待窗口从请求到达就开始计时」)。
 * 与 GateRejection 的两支共用同一个 kind 判别式,所以 isRejection 不适用于它——
 * 见下方 isAdmissionRejected。
 */
export type GateAdmission =
	| { kind: "admitted"; ticket: GateTicket }
	| { kind: "queued"; ticket: Promise<GateTicket> }
	| GateRejection;

export function isRejection(x: GateTicket | GateRejection): x is GateRejection {
	return "kind" in x;
}

/** GateAdmission 专用的窄化谓词:admitted/queued 之外都是拒绝。 */
export function isAdmissionRejected(x: GateAdmission): x is GateRejection {
	return x.kind !== "admitted" && x.kind !== "queued";
}

export class Gate {
	private readonly maxConcurrent: number;
	private readonly maxQueueDepth: number;
	private readonly retryAfterSeconds: number;
	private readonly busySessions = new Set<string>();
	private readonly waiting: Array<{ sessionId: string; resolve: (ticket: GateTicket) => void }> = [];
	private active = 0;

	constructor(options: GateOptions = {}) {
		this.maxConcurrent = options.maxConcurrent ?? 4;
		this.maxQueueDepth = options.maxQueueDepth ?? 16;
		this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
	}

	get activeCount(): number {
		return this.active;
	}

	get queueDepth(): number {
		return this.waiting.length;
	}

	/**
	 * 同步准入判定。语义与 acquire 完全一致,只是把结果拆成三支,好让调用方在
	 * 不 await 的情况下立刻分辨「立即被拒」和「要排队」。
	 */
	tryAcquire(sessionId: string): GateAdmission {
		// 会话级先判:同一会话忙就直接 409,不该进全局队列白等。
		if (this.busySessions.has(sessionId)) return { kind: "session_busy" };
		this.busySessions.add(sessionId);

		if (this.active < this.maxConcurrent) {
			this.active++;
			return { kind: "admitted", ticket: this.makeTicket(sessionId) };
		}
		if (this.waiting.length >= this.maxQueueDepth) {
			// 拒绝时必须把刚占上的会话位还回去,否则该会话永久假忙。
			this.busySessions.delete(sessionId);
			return { kind: "queue_full", retryAfterSeconds: this.retryAfterSeconds };
		}
		// ⚠ 这个 promise 没有取消机制:调用方一旦放弃等待,就会永久泄漏一个队列位与
		// 会话位,Gate 层无法自愈。当前唯一的合法调用方(RunManager)保证会把这条链
		// 驱动到底、不放弃,所以该泄漏当前不可达;若将来出现会放弃等待的调用方,必须
		// 先给 Gate 加取消支持。
		const ticket = new Promise<GateTicket>((resolve) => {
			this.waiting.push({ sessionId, resolve });
		});
		return { kind: "queued", ticket };
	}

	/** acquire 是 tryAcquire 的薄包装:admitted 直接拆出 ticket,queued 就 await 那个 promise。 */
	async acquire(sessionId: string): Promise<GateTicket | GateRejection> {
		const admission = this.tryAcquire(sessionId);
		switch (admission.kind) {
			case "admitted":
				return admission.ticket;
			case "queued":
				return await admission.ticket;
			default:
				return admission;
		}
	}

	private makeTicket(sessionId: string): GateTicket {
		let released = false;
		return {
			release: () => {
				// 幂等:RunManager 的正常路径与错误路径都会 release,重复调用不该把计数带成负数。
				if (released) return;
				released = true;
				this.busySessions.delete(sessionId);
				const next = this.waiting.shift();
				if (next) {
					next.resolve(this.makeTicket(next.sessionId));
					return;
				}
				this.active--;
			},
		};
	}
}
