import { expect, it } from "vitest";
import { createSqliteStateStore } from "../src/state/store.ts";
import { ToolLedger } from "../src/state/tool-ledger.ts";

it("replays completed tool results without a second side effect and rejects changed arguments", async () => {
	const store = createSqliteStateStore(":memory:");
	try {
		const ledger = new ToolLedger(store);
		const request = {
			scope: "s",
			runId: "r",
			callId: "c",
			tool: "write",
			effect: "non_idempotent_write" as const,
			args: { a: 1 },
		};
		let calls = 0;
		const invoke = async () => {
			calls++;
			return { ok: true };
		};
		expect(await ledger.execute(request, invoke)).toEqual({ ok: true });
		expect(await ledger.execute(request, invoke)).toEqual({ ok: true });
		expect(calls).toBe(1);
		await expect(ledger.execute({ ...request, args: { a: 2 } }, invoke)).rejects.toThrow("tool_idempotency_conflict");
	} finally {
		await store.close();
	}
});

it("never replays an uncertain non-idempotent write after its lease expires", async () => {
	const store = createSqliteStateStore(":memory:");
	let now = 0;
	try {
		const ledger = new ToolLedger(store, { now: () => now, leaseMs: 10 });
		const request = {
			scope: "s",
			runId: "r",
			callId: "c",
			tool: "write",
			effect: "non_idempotent_write" as const,
			args: {},
		};
		let finish!: (value: unknown) => void;
		const first = ledger.execute(
			request,
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await expect.poll(() => typeof finish).toBe("function");
		now = 11;
		await expect(ledger.execute(request, async () => "duplicate")).rejects.toThrow("tool_outcome_unknown");
		finish("done");
		await expect(first).rejects.toThrow("tool_ownership_lost");
	} finally {
		await store.close();
	}
});

it("allows an expired idempotent write only with the same downstream key", async () => {
	const store = createSqliteStateStore(":memory:");
	let now = 0;
	try {
		const ledger = new ToolLedger(store, { now: () => now, leaseMs: 10 });
		const request = {
			scope: "s",
			runId: "r",
			callId: "c",
			tool: "write",
			effect: "idempotent_write" as const,
			args: {},
		};
		let finish!: (value: unknown) => void;
		let firstKey = "";
		const first = ledger.execute(request, ({ idempotencyKey }) => {
			firstKey = idempotencyKey;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		await expect.poll(() => firstKey).not.toBe("");
		now = 11;
		await ledger.execute(request, async ({ idempotencyKey }) => {
			expect(idempotencyKey).toBe(firstKey);
			return "done";
		});
		finish("stale");
		await expect(first).rejects.toThrow("tool_ownership_lost");
	} finally {
		await store.close();
	}
});
