import postgres from "postgres";
import type { LimitKind, RunResult } from "../runtime/contract.ts";
import type { NewRun, RunRecord, RunStore, StoredRunStatus } from "./contract.ts";

const RUN_COLUMNS = `
  run_id, client_request_id, request_id, spec_id, task_kind, session_id,
  filters_json, options_json, payload_json, status, input, output,
  error_message, stop_reason, limit_hit, usage_json, turns,
  source_details_json, created_at, started_at, finished_at`;

type Row = Record<string, unknown>;

function dateMs(value: unknown): number | undefined {
	return value instanceof Date ? value.getTime() : undefined;
}

function objectJson(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function arrayJson(value: unknown): Array<Record<string, unknown>> | undefined {
	return Array.isArray(value)
		? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		: undefined;
}

function toRecord(row: Row): RunRecord {
	return {
		runId: String(row.run_id),
		clientRequestId: String(row.client_request_id),
		requestId: typeof row.request_id === "string" ? row.request_id : undefined,
		specId: String(row.spec_id),
		taskKind: String(row.task_kind),
		sessionId: String(row.session_id),
		filtersJson: JSON.stringify(objectJson(row.filters_json) ?? {}),
		optionsJson: row.options_json === null ? undefined : JSON.stringify(row.options_json),
		payloadJson: row.payload_json === null ? undefined : JSON.stringify(row.payload_json),
		status: String(row.status) as StoredRunStatus,
		input: String(row.input),
		output: typeof row.output === "string" ? row.output : undefined,
		errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
		stopReason: typeof row.stop_reason === "string" ? row.stop_reason : undefined,
		limitHit: typeof row.limit_hit === "string" ? (row.limit_hit as LimitKind) : undefined,
		usageJson: row.usage_json === null ? undefined : JSON.stringify(row.usage_json),
		turns: typeof row.turns === "number" ? row.turns : undefined,
		sourceDetails: arrayJson(row.source_details_json) as RunRecord["sourceDetails"],
		createdAt: dateMs(row.created_at) ?? 0,
		startedAt: dateMs(row.started_at),
		finishedAt: dateMs(row.finished_at),
	};
}

function jsonValue(value: string | undefined): string | null {
	return value === undefined ? null : value;
}

function requireUpdated(rows: readonly Row[], runId: string): void {
	if (rows.length === 0) throw new Error(`Run "${runId}" not found`);
}

/** PostgreSQL 是生产唯一任务历史库；连接 DSN 使用 audit-ai 的 PIPELINE_DB_DSN。 */
export async function createPostgresRunStore(dsn: string): Promise<RunStore<true>> {
	if (!dsn) throw new Error("PIPELINE_DB_DSN is required for PostgreSQL task history");
	const sql = postgres(dsn, { max: 10, idle_timeout: 20 });
	try {
		await sql`SELECT 1`;
	} catch (error) {
		await sql.end({ timeout: 1 }).catch(() => {});
		throw error;
	}

	return {
		async insertQueued(rec: NewRun) {
			const inserted = await sql.unsafe(
				`INSERT INTO task_runs (
          run_id, client_request_id, request_id, spec_id, task_kind, session_id,
          filters_json, options_json, payload_json, status, input
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10)
        ON CONFLICT (client_request_id) DO NOTHING
        RETURNING ${RUN_COLUMNS}`,
				[
					rec.runId,
					rec.clientRequestId,
					rec.requestId ?? null,
					rec.specId,
					rec.taskKind,
					rec.sessionId,
					jsonValue(rec.filtersJson),
					jsonValue(rec.optionsJson),
					jsonValue(rec.payloadJson),
					rec.input,
				],
			);
			if (inserted.length > 0) return { inserted: true, run: toRecord(inserted[0] as Row) };
			const existing = await sql.unsafe(`SELECT ${RUN_COLUMNS} FROM task_runs WHERE client_request_id = $1`, [
				rec.clientRequestId,
			]);
			if (existing.length === 0) throw new Error("task run idempotency conflict could not be read back");
			return { inserted: false, run: toRecord(existing[0] as Row) };
		},
		async findByRunId(runId) {
			const rows = await sql.unsafe(`SELECT ${RUN_COLUMNS} FROM task_runs WHERE run_id = $1`, [runId]);
			return rows.length === 0 ? undefined : toRecord(rows[0] as Row);
		},
		async markRunning(runId, startedAt) {
			const rows = await sql.unsafe(
				"UPDATE task_runs SET status = 'running', started_at = to_timestamp($1 / 1000.0), updated_at = now() WHERE run_id = $2 RETURNING run_id",
				[startedAt, runId],
			);
			requireUpdated(rows as Row[], runId);
		},
		async finish(runId, result: RunResult, finishedAt) {
			const rows = await sql.unsafe(
				`UPDATE task_runs SET
          status = $1, output = $2, error_message = $3, stop_reason = $4, limit_hit = $5,
          usage_json = $6, turns = $7, source_details_json = $8,
          finished_at = to_timestamp($9 / 1000.0), updated_at = now()
        WHERE run_id = $10 RETURNING run_id`,
				[
					result.status,
					result.output ?? null,
					result.errorMessage ?? null,
					result.stopReason ?? null,
					result.limit ?? null,
					JSON.stringify(result.usage),
					result.turns,
					result.sourceDetails ? JSON.stringify(result.sourceDetails) : null,
					finishedAt,
					runId,
				],
			);
			requireUpdated(rows as Row[], runId);
		},
		async markError(runId, message, finishedAt) {
			const rows = await sql.unsafe(
				"UPDATE task_runs SET status = 'error', error_message = $1, finished_at = to_timestamp($2 / 1000.0), updated_at = now() WHERE run_id = $3 RETURNING run_id",
				[message, finishedAt, runId],
			);
			requireUpdated(rows as Row[], runId);
		},
		async deleteRun(runId) {
			await sql.unsafe("DELETE FROM task_runs WHERE run_id = $1", [runId]);
		},
		async recoverStaleRuns(now) {
			const rows = await sql.unsafe(
				"UPDATE task_runs SET status = 'error', error_message = 'process restarted', finished_at = to_timestamp($1 / 1000.0), updated_at = now() WHERE status IN ('queued', 'running') RETURNING run_id",
				[now],
			);
			return rows.length;
		},
		async appendEvents(runId, events) {
			if (events.length === 0) return;
			await sql.begin(async (transaction) => {
				for (const event of events) {
					await transaction.unsafe(
						"INSERT INTO task_run_events (run_id, seq, event_ts, event_type, payload) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)",
						[runId, event.seq, event.ts, event.type, JSON.parse(event.payload)],
					);
				}
			});
		},
		async listEvents(runId) {
			const rows = await sql.unsafe(
				"SELECT seq, event_ts, event_type, payload FROM task_run_events WHERE run_id = $1 ORDER BY seq",
				[runId],
			);
			return rows.map((row) => {
				const value = row as Row;
				return {
					seq: Number(value.seq),
					ts: dateMs(value.event_ts) ?? 0,
					type: String(value.event_type),
					payload: JSON.stringify(value.payload),
				};
			});
		},
		async close() {
			await sql.end({ timeout: 5 });
		},
	};
}
