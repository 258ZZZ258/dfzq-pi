import { describe, expect, it } from "vitest";
import { Gate, isAdmissionRejected, isRejection } from "../src/server/gate.ts";

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

	// 设计裁定追加用例①:tryAcquire 必须同步区分 admitted / session_busy / queue_full / queued 四支,
	// 且 queue_full 分支要归还会话位,queued 分支要在持票者 release 后 resolve 成可用 ticket。
	it("tryAcquire synchronously distinguishes admitted, session_busy, queue_full, and queued", async () => {
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 1 });

		// 有空位 → admitted
		const admission1 = gate.tryAcquire("s1");
		expect(admission1.kind).toBe("admitted");
		expect(isAdmissionRejected(admission1)).toBe(false);
		if (admission1.kind !== "admitted") throw new Error("unexpected");
		expect(gate.activeCount).toBe(1);

		// 同会话 → session_busy(同步返回,不进队列)
		const busy = gate.tryAcquire("s1");
		expect(busy).toEqual({ kind: "session_busy" });
		expect(isAdmissionRejected(busy)).toBe(true);

		// 无空位但队未满 → queued
		const admission2 = gate.tryAcquire("s2");
		expect(admission2.kind).toBe("queued");
		if (admission2.kind !== "queued") throw new Error("unexpected");
		expect(gate.queueDepth).toBe(1);

		// 队满 → queue_full,且刚占上的会话位被归还
		const full = gate.tryAcquire("s3");
		expect(full).toEqual({ kind: "queue_full", retryAfterSeconds: 5 });
		expect(isAdmissionRejected(full)).toBe(true);

		// s1 释放后,s2 排队中的 promise 应该 resolve 成可用 ticket
		admission1.ticket.release();
		const s2Ticket = await admission2.ticket;
		expect(typeof s2Ticket.release).toBe("function");

		// s3 的会话位已在 queue_full 时被归还,此时重新 tryAcquire 应该能排上队,
		// 而不是再次被误判为 session_busy。
		const retry = gate.tryAcquire("s3");
		expect(retry.kind).toBe("queued");
	});

	// 设计裁定追加用例②(审查提的 Minor):两级等待链上 activeCount 必须全程恒为 1,
	// 不能在 handoff 分支里被误加 this.active--(那样会让计数在两个持票者交接的瞬间跌到 0,
	// 即便实际上一直有一个 ticket 处于占用状态)。同时验证 B、C 拿到的是各自独立的 ticket。
	it("keeps activeCount pinned at 1 through a two-level handoff chain", async () => {
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 4 });

		const a = await gate.acquire("a");
		if (isRejection(a)) throw new Error("unexpected rejection");
		expect(gate.activeCount).toBe(1);

		const bPromise = gate.acquire("b");
		await Promise.resolve();
		expect(gate.queueDepth).toBe(1);

		const cPromise = gate.acquire("c");
		await Promise.resolve();
		expect(gate.queueDepth).toBe(2);

		// A 释放 → B 从队列被放行。全程 active 应该恒为 1,从未跌到 0。
		a.release();
		const b = await bPromise;
		if (isRejection(b)) throw new Error("unexpected rejection");
		expect(gate.activeCount).toBe(1);
		expect(gate.queueDepth).toBe(1);

		// B 释放 → C 从队列被放行。同样,active 应该恒为 1。
		b.release();
		const c = await cPromise;
		if (isRejection(c)) throw new Error("unexpected rejection");
		expect(gate.activeCount).toBe(1);
		expect(gate.queueDepth).toBe(0);

		// B 与 C 是各自独立的 ticket:B 上的重复 release 是 no-op,不影响 C。
		b.release();
		expect(gate.activeCount).toBe(1);

		c.release();
		expect(gate.activeCount).toBe(0);
	});
});
