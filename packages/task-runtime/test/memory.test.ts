import { expect, it } from "vitest";
import { MemoryService } from "../src/memory/service.ts";
import { createSqliteStateStore } from "../src/state/store.ts";

const scope = { tenantId: "t", userId: "u" };

it("supports semantic vectors, bounded context, and pruning without reusing deleted IDs", async () => {
	const store = createSqliteStateStore(":memory:");
	let now = 1;
	try {
		const memory = new MemoryService(store, {
			now: () => now,
			embedder: { id: "local-v1", embed: async (text) => (text === "成都" || text === "居住地" ? [1, 0] : [0, 1]) },
		});
		const entry = await memory.propose(
			scope,
			{ text: "成都", category: "fact", source: "user", sourceRef: "user" },
			"idempotent",
		);
		expect((await memory.retrieve(scope, "居住地"))[0].id).toBe(entry.id);
		expect(await memory.retrieve(scope, "居住地", { maxChars: 1 })).toEqual([]);
		await memory.remove(scope, entry.id, entry.revision);
		now = 2;
		expect(await memory.prune(scope, 0)).toBe(1);
		const next = await memory.propose(
			scope,
			{ text: "成都", category: "fact", source: "user", sourceRef: "user" },
			"idempotent",
		);
		expect(next.id).not.toBe(entry.id);
		await expect(memory.remove(scope, entry.id, 1)).rejects.toThrow("memory_revision_conflict");
	} finally {
		await store.close();
	}
});

it("invalidates a pending summary when its source is edited before approval", async () => {
	const store = createSqliteStateStore(":memory:");
	try {
		const memory = new MemoryService(store);
		const entry = await memory.propose(
			scope,
			{ text: "偏好短回答", category: "preference", source: "user", sourceRef: "user" },
			"p",
		);
		const summary = await memory.compact(scope, [entry.id], "偏好简短", "s");
		await memory.revise(scope, entry.id, entry.revision, "偏好详细回答", "user-edit");
		await expect(memory.approve(scope, summary.id, summary.revision)).rejects.toThrow("memory_summary_stale");
	} finally {
		await store.close();
	}
});
it("isolates scopes, keeps model proposals inactive, and rejects stale updates", async () => {
	const store = createSqliteStateStore(":memory:");
	try {
		const memory = new MemoryService(store);
		const candidate = await memory.propose(
			scope,
			{ text: "请使用简洁中文回答", category: "preference", source: "model", sourceRef: "run1" },
			"k",
		);
		expect(await memory.retrieve(scope, "中文回答")).toEqual([]);
		const active = await memory.approve(scope, candidate.id, candidate.revision);
		expect((await memory.retrieve(scope, "中文回答"))[0].id).toBe(active.id);
		expect(await memory.retrieve({ ...scope, userId: "other" }, "中文回答")).toEqual([]);
		await expect(memory.remove(scope, active.id, candidate.revision)).rejects.toThrow("memory_revision_conflict");
		await memory.remove(scope, active.id, active.revision);
		expect(await memory.retrieve(scope, "中文回答")).toEqual([]);
	} finally {
		await store.close();
	}
});

it("expires memories and supersedes conflicting facts without returning stale content", async () => {
	const store = createSqliteStateStore(":memory:");
	let now = 1;
	try {
		const memory = new MemoryService(store, { now: () => now });
		await memory.propose(
			scope,
			{
				text: "办公地点北京",
				category: "fact",
				source: "user",
				sourceRef: "user",
				conflictKey: "office",
				expiresAt: 10,
			},
			"a",
		);
		await memory.propose(
			scope,
			{
				text: "办公地点上海",
				category: "fact",
				source: "user",
				sourceRef: "user",
				conflictKey: "office",
				expiresAt: 10,
			},
			"b",
		);
		expect((await memory.retrieve(scope, "办公地点")).map((item) => item.text)).toEqual(["办公地点上海"]);
		now = 11;
		expect(await memory.retrieve(scope, "办公地点")).toEqual([]);
	} finally {
		await store.close();
	}
});

it("retains compaction provenance and invalidates derived summaries on source deletion", async () => {
	const store = createSqliteStateStore(":memory:");
	try {
		const memory = new MemoryService(store);
		const original = await memory.propose(
			scope,
			{ text: "喜欢简洁回答", category: "preference", source: "user", sourceRef: "user" },
			"original",
		);
		const summary = await memory.compact(scope, [original.id], "用户偏好简洁回答", "summary");
		expect(summary.status).toBe("candidate");
		const approved = await memory.approve(scope, summary.id, summary.revision);
		expect((await memory.retrieve(scope, "简洁回答"))[0].id).toBe(approved.id);
		const items = await memory.list(scope);
		const source = items.find((item) => item.id === original.id);
		if (!source) throw new Error("missing source");
		await memory.remove(scope, source.id, source.revision);
		expect(await memory.retrieve(scope, "简洁回答")).toEqual([]);
	} finally {
		await store.close();
	}
});
