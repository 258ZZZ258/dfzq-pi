import { describe, expect, it } from "vitest";
import { Gate, isRejection } from "../src/server/gate.ts";

describe("gate", () => {
	it("admits a run and reports it active", async () => {
		const gate = new Gate({ maxConcurrent: 2 });
		const ticket = await gate.acquire("s1");
		expect(isRejection(ticket)).toBe(false);
		expect(gate.activeCount).toBe(1);
	});

	it("rejects a second run on the same session", async () => {
		const gate = new Gate({ maxConcurrent: 4 });
		await gate.acquire("s1");
		const second = await gate.acquire("s1");
		expect(second).toEqual({ kind: "session_busy" });
	});

	it("frees the session slot on release", async () => {
		const gate = new Gate({ maxConcurrent: 4 });
		const first = await gate.acquire("s1");
		if (isRejection(first)) throw new Error("unexpected rejection");
		first.release();
		const second = await gate.acquire("s1");
		expect(isRejection(second)).toBe(false);
	});

	it("queues past the global limit and admits on release", async () => {
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 4 });
		const first = await gate.acquire("s1");
		if (isRejection(first)) throw new Error("unexpected rejection");

		let admitted = false;
		const pending = gate.acquire("s2").then((t) => {
			admitted = !isRejection(t);
			return t;
		});
		// 队列里,还没放行
		await Promise.resolve();
		expect(admitted).toBe(false);
		expect(gate.queueDepth).toBe(1);

		first.release();
		const second = await pending;
		expect(isRejection(second)).toBe(false);
		expect(gate.queueDepth).toBe(0);
	});

	it("rejects with retry-after when the queue is full", async () => {
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 1, retryAfterSeconds: 7 });
		const held = await gate.acquire("s1");
		if (isRejection(held)) throw new Error("unexpected rejection");
		void gate.acquire("s2"); // 占满队列
		const rejected = await gate.acquire("s3");
		expect(rejected).toEqual({ kind: "queue_full", retryAfterSeconds: 7 });
		held.release();
	});

	it("is idempotent on double release", async () => {
		const gate = new Gate({ maxConcurrent: 2 });
		const ticket = await gate.acquire("s1");
		if (isRejection(ticket)) throw new Error("unexpected rejection");
		ticket.release();
		ticket.release();
		expect(gate.activeCount).toBe(0);
	});

	// 追加用例:队列满被拒时必须把刚占上的会话位还回去,否则该 sessionId 会永久假忙。
	// 这里用同一个 sessionId(s3)在被拒后重新 acquire,验证会话位确实被归还。
	it("allows the same sessionId to acquire again after a queue-full rejection", async () => {
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 1 });
		const held = await gate.acquire("s1");
		if (isRejection(held)) throw new Error("unexpected rejection");

		const queuedPromise = gate.acquire("s2"); // 占满队列
		const rejected = await gate.acquire("s3");
		expect(rejected).toEqual({ kind: "queue_full", retryAfterSeconds: 5 });

		held.release(); // s1 让出槽位,排队中的 s2 被放行
		const queued = await queuedPromise;
		if (isRejection(queued)) throw new Error("unexpected rejection");

		// 若 s3 的会话位在被拒时没有归还,这里会被误判为 session_busy 而不是排队。
		const retryPromise = gate.acquire("s3");
		queued.release(); // s2 让出槽位,s3 才能被放行
		const retry = await retryPromise;
		expect(isRejection(retry)).toBe(false);
	});
});
