import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
		judgeAttempts: {},
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

	it("deleteRun removes the row so a later insertQueued with the same clientRequestId is a fresh insert", () => {
		store.insertQueued(newRun());
		store.deleteRun("run-1");
		expect(store.findByRunId("run-1")).toBeUndefined();

		// 撤销幂等占用的核心断言:同一 clientRequestId 再次 insertQueued 必须真的 inserted:true,
		// 而不是命中 ON CONFLICT DO NOTHING 拿到一行已经不存在的旧行(finding #1)。
		const retried = store.insertQueued(newRun({ runId: "run-2" }));
		expect(retried.inserted).toBe(true);
		expect(retried.run.runId).toBe("run-2");
	});

	it("deleteRun on an unknown runId does not throw", () => {
		expect(() => store.deleteRun("no-such-run")).not.toThrow();
	});

	it("payload_json 原样存档并读回(嵌套结构 + null 值一字不差)", () => {
		// 嵌套 + null 值特意挑来验证「原样」:如果实现在存档前后走过一趟
		// JSON.parse/JSON.stringify 之类的往返而不是原样字符串,这条最容易先暴露出差异。
		const payloadJson = JSON.stringify({
			external: { objectKey: "k1", uploadId: "U1", filename: "f.pdf", meta: { pages: 10, ocr: null } },
			note: null,
		});
		store.insertQueued(newRun({ payloadJson }));
		expect(store.findByRunId("run-1")?.payloadJson).toBe(payloadJson);
	});

	it("不传 payload 时该列为 undefined,不补默认值", () => {
		store.insertQueued(newRun());
		expect(store.findByRunId("run-1")?.payloadJson).toBeUndefined();
	});

	it("迁移幂等:对已存在但没有 payload_json 列的库文件重新打开,列被补上且既有行完好", () => {
		const dbPath = join(root, "legacy.db");
		// 手写迁移前的 DDL(没有 payload_json 列),模拟本仓已经在生产跑着的旧库文件。
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE runs (
			  run_id            TEXT PRIMARY KEY,
			  client_request_id TEXT NOT NULL,
			  request_id        TEXT,
			  spec_id           TEXT NOT NULL,
			  task_kind         TEXT NOT NULL,
			  session_id        TEXT NOT NULL,
			  filters_json      TEXT NOT NULL,
			  options_json      TEXT,
			  status            TEXT NOT NULL,
			  input             TEXT NOT NULL,
			  output            TEXT,
			  error_message     TEXT,
			  stop_reason       TEXT,
			  limit_hit         TEXT,
			  usage_json        TEXT,
			  turns             INTEGER,
			  created_at        INTEGER NOT NULL,
			  started_at        INTEGER,
			  finished_at       INTEGER
			);
		`);
		legacy.exec(
			`INSERT INTO runs (run_id, client_request_id, spec_id, task_kind, session_id, filters_json, status, input, created_at)
			 VALUES ('legacy-1', 'legacy-cli-1', 'demo', 'demo', 'sess', '{"corpusTypes":["internal"]}', 'queued', 'hi', 1000)`,
		);
		legacy.close();

		// 用带迁移逻辑的实现重新打开同一个文件:既有行的其它列必须完好,新列缺省为 undefined。
		const migrated = createSqliteRunStore(dbPath);
		const row = migrated.findByRunId("legacy-1");
		expect(row?.payloadJson).toBeUndefined();
		expect(row?.input).toBe("hi");
		expect(row?.clientRequestId).toBe("legacy-cli-1");
		expect(row?.filtersJson).toBe('{"corpusTypes":["internal"]}');

		// 幂等:列已存在后再次打开不报错(ALTER TABLE ADD COLUMN 不会重复执行),
		// 且新插入的行能正常写读 payload_json。
		migrated.close();
		expect(() => {
			const reopened = createSqliteRunStore(dbPath);
			reopened.insertQueued(newRun({ runId: "legacy-2", clientRequestId: "legacy-cli-2", payloadJson: '{"x":1}' }));
			expect(reopened.findByRunId("legacy-2")?.payloadJson).toBe('{"x":1}');
			reopened.close();
		}).not.toThrow();
	});
});
