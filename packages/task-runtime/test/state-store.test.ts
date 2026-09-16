import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSqliteStateStore } from "../src/state/store.ts";

it("provides durable atomic compare-and-swap across independent connections", async () => {
	const dir = await mkdtemp(join(tmpdir(), "state-cas-"));
	const a = createSqliteStateStore(join(dir, "state.db"));
	const b = createSqliteStateStore(join(dir, "state.db"));
	try {
		const claims = await Promise.all([
			a.compareAndSwap("k", null, { owner: "a" }),
			b.compareAndSwap("k", null, { owner: "b" }),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(await b.get("k")).toMatchObject({ revision: 1 });
		expect(await b.compareAndSwap("k", 1, { deleted: true })).toBe(true);
		expect(await a.compareAndSwap("k", 1, { stale: true })).toBe(false);
		expect(await a.compareAndSwap("k", null, { recreated: true })).toBe(false);
		await a.close();
		await b.close();
		const reopened = createSqliteStateStore(join(dir, "state.db"));
		try {
			expect(await reopened.get("k")).toEqual({ revision: 2, value: { deleted: true } });
		} finally {
			await reopened.close();
		}
	} finally {
		await a.close();
		await b.close();
		await rm(dir, { recursive: true, force: true });
	}
});
