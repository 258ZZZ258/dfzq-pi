import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../src/runtime/contract.ts";
import type { NewRun, RunStore } from "../src/store/contract.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";

let root: string;
let store: RunStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-store-"));
	store = createSqliteRunStore(join(root, "runs.db"));
});

afterEach(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

function newRun(overrides: Partial<NewRun> = {}): NewRun {
	return {
		runId: "run-1",
		clientRequestId: "cli-1",
		specId: "demo",
		taskKind: "demo",
		sessionId: "sess-1",
		filtersJson: '{"permTags":["内部"],"corpusTypes":["internal"]}',
		input: "hello",
		createdAt: 1000,
		...overrides,
	};
}

function result(overrides: Partial<RunResult> = {}): RunResult {
	return {
		runId: "run-1",
		specId: "demo",
		status: "completed",
		output: "done",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.5 },
		turns: 2,
		durationMs: 42,
		...overrides,
	};
}

describe("sqlite run store", () => {
	it("inserts a queued run and reads it back", () => {
		const first = store.insertQueued(newRun());
		expect(first.inserted).toBe(true);
		expect(first.run.status).toBe("queued");
		expect(store.findByRunId("run-1")?.input).toBe("hello");
	});

	it("stores filters_json verbatim", () => {
		const raw = '{"permTags":["内部"],"corpusTypes":["internal"],"projectId":null}';
		store.insertQueued(newRun({ filtersJson: raw }));
		expect(store.findByRunId("run-1")?.filtersJson).toBe(raw);
	});

	it("returns the existing run when clientRequestId repeats", () => {
		store.insertQueued(newRun());
		const second = store.insertQueued(newRun({ runId: "run-2" }));
		expect(second.inserted).toBe(false);
		expect(second.run.runId).toBe("run-1");
		expect(store.findByRunId("run-2")).toBeUndefined();
	});

	it("records a terminal result with its limit kind", () => {
		store.insertQueued(newRun());
		store.markRunning("run-1", 1100);
		store.finish("run-1", result({ status: "limit_exceeded", limit: "maxTurns" }), 1200);
		const row = store.findByRunId("run-1");
		expect(row?.status).toBe("limit_exceeded");
		expect(row?.limitHit).toBe("maxTurns");
		expect(row?.turns).toBe(2);
		expect(row?.startedAt).toBe(1100);
		expect(row?.finishedAt).toBe(1200);
		expect(JSON.parse(row?.usageJson ?? "{}")).toMatchObject({ total: 3, cost: 0.5 });
	});

	it("marks a run as error", () => {
		store.insertQueued(newRun());
		store.markError("run-1", "assemble failed", 1300);
		expect(store.findByRunId("run-1")).toMatchObject({
			status: "error",
			errorMessage: "assemble failed",
			finishedAt: 1300,
		});
	});

	it("recovers stale runs on startup", () => {
		store.insertQueued(newRun());
		store.insertQueued(newRun({ runId: "run-2", clientRequestId: "cli-2" }));
		store.markRunning("run-2", 1100);

		const affected = store.recoverStaleRuns(9000);
		expect(affected).toBe(2);
		for (const id of ["run-1", "run-2"]) {
			expect(store.findByRunId(id)).toMatchObject({
				status: "error",
				errorMessage: "process restarted",
				finishedAt: 9000,
			});
		}
	});

	it("does not touch already-terminal runs on recovery", () => {
		store.insertQueued(newRun());
		store.finish("run-1", result(), 1200);
		expect(store.recoverStaleRuns(9000)).toBe(0);
		expect(store.findByRunId("run-1")?.status).toBe("completed");
	});

	it("appends events keyed by (run_id, seq)", () => {
		store.insertQueued(newRun());
		store.appendEvents("run-1", [
			{ seq: 1, ts: 10, type: "turn_end", payload: "{}" },
			{ seq: 2, ts: 20, type: "agent_end", payload: "{}" },
		]);
		// 重复 seq 必须抛,证明主键生效
		expect(() => store.appendEvents("run-1", [{ seq: 1, ts: 30, type: "turn_end", payload: "{}" }])).toThrow();
	});

	it("survives reopening the same file", () => {
		store.insertQueued(newRun());
		store.close();
		const reopened = createSqliteRunStore(join(root, "runs.db"));
		expect(reopened.findByRunId("run-1")?.status).toBe("queued");
		reopened.close();
	});

	it("appendEvents is all-or-nothing: a mid-batch primary key collision leaves no partial rows", () => {
		store.insertQueued(newRun());
		store.appendEvents("run-1", [{ seq: 1, ts: 10, type: "turn_end", payload: "{}" }]);

		// 批里第二条(seq:1)撞已存在的行,第一条(seq:2)和第三条(seq:3)本身都不冲突。
		// 若实现是「逐条 run() 没有事务」,seq:2 会先落盘,再遇到 seq:1 冲突才抛;
		// 若实现是「整批一个事务」,抛错时 seq:2 应该也被回滚掉、什么都没留下。
		expect(() =>
			store.appendEvents("run-1", [
				{ seq: 2, ts: 20, type: "agent_end", payload: "{}" },
				{ seq: 1, ts: 30, type: "turn_end", payload: "{}" }, // 撞 (run-1, 1)
				{ seq: 3, ts: 40, type: "agent_end", payload: "{}" },
			]),
		).toThrow();

		// 用「重新插入同样的 seq」代替直接查 run_events 表:
		// 如果上一批的 seq:2 / seq:3 已经残留落盘,这里会因为主键冲突再次抛错;
		// 不抛就证明上一批被完整回滚,没有部分成功。
		expect(() =>
			store.appendEvents("run-1", [
				{ seq: 2, ts: 999, type: "agent_end", payload: "{}" },
				{ seq: 3, ts: 999, type: "agent_end", payload: "{}" },
			]),
		).not.toThrow();
	});

	it("markRunning throws for an unknown runId instead of a silent no-op", () => {
		expect(() => store.markRunning("no-such-run", 1000)).toThrow(/no-such-run/);
	});

	it("finish throws for an unknown runId instead of a silent no-op", () => {
		expect(() => store.finish("no-such-run", result(), 1200)).toThrow(/no-such-run/);
	});

	it("markError throws for an unknown runId instead of a silent no-op", () => {
		expect(() => store.markError("no-such-run", "boom", 1300)).toThrow(/no-such-run/);
	});
});
