/**
 * 两级闸门(设计文档 §5.3)。pi 零限流,且 D8(无 SSE)意味着 Java 感知不到服务繁忙。
 *
 * 会话级恒为 1 不是产能策略而是**内核约束**:AgentSession 不支持并发 prompt(),
 * 同一会话被并发驱动会撞坏状态。
 *
 * ⚠ maxConcurrent 默认 4 / maxQueueDepth 默认 16 / retryAfterSeconds 默认 5 是**临时值**。
 * 风险 1(单会话内存无界)未经测量,S1b 拿到内存曲线、S3 做校准之前不放大(设计文档 §10-5)。
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

export function isRejection(x: GateTicket | GateRejection): x is GateRejection {
	return "kind" in x;
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

	async acquire(sessionId: string): Promise<GateTicket | GateRejection> {
		// 会话级先判:同一会话忙就直接 409,不该进全局队列白等。
		if (this.busySessions.has(sessionId)) return { kind: "session_busy" };
		this.busySessions.add(sessionId);

		if (this.active < this.maxConcurrent) {
			this.active++;
			return this.makeTicket(sessionId);
		}
		if (this.waiting.length >= this.maxQueueDepth) {
			// 拒绝时必须把刚占上的会话位还回去,否则该会话永久假忙。
			this.busySessions.delete(sessionId);
			return { kind: "queue_full", retryAfterSeconds: this.retryAfterSeconds };
		}
		return new Promise<GateTicket>((resolve) => {
			this.waiting.push({ sessionId, resolve });
		});
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
