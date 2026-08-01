import { DatabaseSync } from "node:sqlite";
import type { LimitKind, RunResult } from "../runtime/contract.ts";
import type { NewRun, RunRecord, RunStore, StoredEvent, StoredRunStatus } from "./contract.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_client_req ON runs(client_request_id);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS run_events (
  run_id  TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  type    TEXT    NOT NULL,
  payload TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`;

interface RunRow {
	run_id: string;
	client_request_id: string;
	request_id: string | null;
	spec_id: string;
	task_kind: string;
	session_id: string;
	filters_json: string;
	options_json: string | null;
	status: string;
	input: string;
	output: string | null;
	error_message: string | null;
	stop_reason: string | null;
	limit_hit: string | null;
	usage_json: string | null;
	turns: number | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
}

/** SQL NULL 与 TS optional 的边界只在这一处翻译,别处不再判 null。 */
function toRecord(row: RunRow): RunRecord {
	return {
		runId: row.run_id,
		clientRequestId: row.client_request_id,
		requestId: row.request_id ?? undefined,
		specId: row.spec_id,
		taskKind: row.task_kind,
		sessionId: row.session_id,
		filtersJson: row.filters_json,
		optionsJson: row.options_json ?? undefined,
		status: row.status as StoredRunStatus,
		input: row.input,
		output: row.output ?? undefined,
		errorMessage: row.error_message ?? undefined,
		stopReason: row.stop_reason ?? undefined,
		limitHit: (row.limit_hit as LimitKind | null) ?? undefined,
		usageJson: row.usage_json ?? undefined,
		turns: row.turns ?? undefined,
		createdAt: row.created_at,
		startedAt: row.started_at ?? undefined,
		finishedAt: row.finished_at ?? undefined,
	};
}

export function createSqliteRunStore(path: string): RunStore {
	const db = new DatabaseSync(path);
	// close() 必须能安全重入:调用方(以及测试的 afterEach)可能在已手动 close 后再 close 一次,
	// 而 node:sqlite 的 DatabaseSync.close() 对已关闭的连接会抛 "database is not open"。
	let closed = false;
	// 写多读少的追加型负载(设计文档 §5.7)。
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(DDL);

	const insert = db.prepare(`
		INSERT INTO runs (run_id, client_request_id, request_id, spec_id, task_kind, session_id,
		                  filters_json, options_json, status, input, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
		ON CONFLICT(client_request_id) DO NOTHING
	`);
	const byRunId = db.prepare("SELECT * FROM runs WHERE run_id = ?");
	const byClientReq = db.prepare("SELECT * FROM runs WHERE client_request_id = ?");
	const setRunning = db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE run_id = ?");
	const setFinished = db.prepare(`
		UPDATE runs SET status = ?, output = ?, error_message = ?, stop_reason = ?, limit_hit = ?,
		                usage_json = ?, turns = ?, finished_at = ?
		WHERE run_id = ?
	`);
	const setError = db.prepare("UPDATE runs SET status = 'error', error_message = ?, finished_at = ? WHERE run_id = ?");
	const del = db.prepare("DELETE FROM runs WHERE run_id = ?");
	const recover = db.prepare(`
		UPDATE runs SET status = 'error', error_message = 'process restarted', finished_at = ?
		WHERE status IN ('queued', 'running')
	`);
	const insertEvent = db.prepare("INSERT INTO run_events (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)");
	const selectEvents = db.prepare("SELECT seq, ts, type, payload FROM run_events WHERE run_id = ? ORDER BY seq");

	function requireByRunId(runId: string): RunRecord {
		const row = byRunId.get(runId) as RunRow | undefined;
		if (!row) throw new Error(`Run "${runId}" not found`);
		return toRecord(row);
	}

	return {
		insertQueued(rec: NewRun) {
			// changes 在部分 node:sqlite 实现上可能是 bigint,统一归一成 number 再比较,
			// 避免 1n === 1 恒为 false 的静默漏判(见 recoverStaleRuns 同款处理)。
			const changes = Number(
				insert.run(
					rec.runId,
					rec.clientRequestId,
					rec.requestId ?? null,
					rec.specId,
					rec.taskKind,
					rec.sessionId,
					rec.filtersJson,
					rec.optionsJson ?? null,
					rec.input,
					rec.createdAt,
				).changes,
			);
			if (changes === 1) return { inserted: true, run: requireByRunId(rec.runId) };
			const existing = byClientReq.get(rec.clientRequestId) as RunRow | undefined;
			// ON CONFLICT 命中却读不到行 = 数据库状态自相矛盾,响亮失败而不是静默造一个空 run。
			if (!existing) throw new Error(`Idempotency conflict on "${rec.clientRequestId}" but no existing row`);
			return { inserted: false, run: toRecord(existing) };
		},
		findByRunId(runId: string) {
			const row = byRunId.get(runId) as RunRow | undefined;
			return row ? toRecord(row) : undefined;
		},
		markRunning(runId: string, startedAt: number) {
			// changes === 0 说明 runId 不存在,响亮失败而不是静默 no-op
			// (与 insertQueued 的「读不到行就抛」同一哲学;RunManager 会真的传坏 runId 进来)。
			const changes = Number(setRunning.run(startedAt, runId).changes);
			if (changes === 0) throw new Error(`markRunning: run "${runId}" not found`);
		},
		finish(runId: string, result: RunResult, finishedAt: number) {
			const changes = Number(
				setFinished.run(
					result.status,
					result.output ?? null,
					result.errorMessage ?? null,
					result.stopReason ?? null,
					result.limit ?? null,
					JSON.stringify(result.usage),
					result.turns,
					finishedAt,
					runId,
				).changes,
			);
			if (changes === 0) throw new Error(`finish: run "${runId}" not found`);
		},
		markError(runId: string, message: string, finishedAt: number) {
			const changes = Number(setError.run(message, finishedAt, runId).changes);
			if (changes === 0) throw new Error(`markError: run "${runId}" not found`);
		},
		deleteRun(runId: string) {
			// 与其余写入方法不同,这里删不到行不抛:契约里已写明「拒绝路径是唯一调用方,
			// 幂等更安全」——不存在的行没有什么可撤销的。
			del.run(runId);
		},
		recoverStaleRuns(now: number) {
			return Number(recover.run(now).changes);
		},
		appendEvents(runId: string, events: StoredEvent[]) {
			// 显式事务:要么整批落盘,要么一条都不落。node:sqlite 的 DatabaseSync 没有
			// better-sqlite3 那种 db.transaction() 帮手,得手写 BEGIN/COMMIT/ROLLBACK。
			// 撞 (run_id, seq) 主键时,SQLite 默认的 ABORT 冲突解决策略只撤销那一条语句,
			// 不会自动撤销同一事务里已经执行成功的前面几条 —— 所以必须显式 ROLLBACK。
			db.exec("BEGIN");
			try {
				for (const event of events) {
					insertEvent.run(runId, event.seq, event.ts, event.type, event.payload);
				}
				db.exec("COMMIT");
			} catch (err) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// ROLLBACK 自己也可能抛(比如事务已被驱动自动回滚掉了)。
					// 吞掉这个次生异常,不能让它盖过下面要抛给调用方的原始错误。
				}
				throw err;
			}
		},
		listEvents(runId: string) {
			const rows = selectEvents.all(runId) as Array<{ seq: number; ts: number; type: string; payload: string }>;
			return rows.map((row) => ({ seq: row.seq, ts: row.ts, type: row.type, payload: row.payload }));
		},
		close() {
			if (closed) return;
			closed = true;
			db.close();
		},
	};
}
