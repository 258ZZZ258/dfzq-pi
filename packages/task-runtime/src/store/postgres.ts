import postgres from "postgres";
import type { LimitKind, RunResult } from "../runtime/contract.ts";
import { sealFailure } from "../runtime/delivery.ts";
import type { NewRun, RunRecord, RunStore, StoredRunStatus } from "./contract.ts";

const RUN_COLUMNS = `
  run_id, client_request_id, request_id, spec_id, task_kind, session_id,
  filters_json, options_json, payload_json, status, input, output,
  error_message, stop_reason, limit_hit, usage_json, turns,
  source_details_json, created_at, started_at, finished_at, session_id_explicit, delivery_json, principal_json`;

type Row = Record<string, unknown>;

// Previous JSONB parameters were serialized twice by the driver. Decode that one extra layer
// when reading existing receipts; never replace an unreadable authorization scope with {}.
function storedJson(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}

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
	const filters = objectJson(storedJson(row.filters_json));
	if (!filters) throw new Error("Stored run authorization scope is not an object");
	return {
		principalJson: row.principal_json == null ? undefined : JSON.stringify(storedJson(row.principal_json)),
		runId: String(row.run_id),
		clientRequestId: String(row.client_request_id),
		requestId: typeof row.request_id === "string" ? row.request_id : undefined,
		specId: String(row.spec_id),
		taskKind: String(row.task_kind),
		sessionId: String(row.session_id),
		sessionIdExplicit: typeof row.session_id_explicit === "boolean" ? row.session_id_explicit : undefined,
		filtersJson: JSON.stringify(filters),
		optionsJson: row.options_json === null ? undefined : JSON.stringify(storedJson(row.options_json)),
		// Filters are always objects: a string identifies a legacy double-encoded row.
		// New payloads may legitimately be strings, including text that looks like JSON.
		payloadJson:
			row.payload_json === null
				? undefined
				: JSON.stringify(typeof row.filters_json === "string" ? storedJson(row.payload_json) : row.payload_json),
		status: String(row.status) as StoredRunStatus,
		input: String(row.input),
		output: typeof row.output === "string" ? row.output : undefined,
		errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
		stopReason: typeof row.stop_reason === "string" ? row.stop_reason : undefined,
		limitHit: typeof row.limit_hit === "string" ? (row.limit_hit as LimitKind) : undefined,
		usageJson: row.usage_json === null ? undefined : JSON.stringify(storedJson(row.usage_json)),
		deliveryJson: row.delivery_json == null ? undefined : JSON.stringify(storedJson(row.delivery_json)),
		turns: typeof row.turns === "number" ? row.turns : undefined,
		sourceDetails: arrayJson(storedJson(row.source_details_json)) as RunRecord["sourceDetails"],
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
	const sql = postgres(dsn, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10,
		connection: { statement_timeout: 15000 },
	});
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
          filters_json, options_json, payload_json, status, input, session_id_explicit, principal_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9::text::jsonb, 'queued', $10, $11, $12::text::jsonb)
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
					rec.sessionIdExplicit ?? null,
					jsonValue(rec.principalJson),
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
		async findByClientRequestId(clientRequestId) {
			const rows = await sql.unsafe(`SELECT ${RUN_COLUMNS} FROM task_runs WHERE client_request_id = $1`, [
				clientRequestId,
			]);
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
          usage_json = $6::text::jsonb, turns = $7, source_details_json = $8::text::jsonb,
          finished_at = to_timestamp($9 / 1000.0), updated_at = now(), delivery_json = $11::text::jsonb
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
					result.delivery ? JSON.stringify(result.delivery) : null,
				],
			);
			requireUpdated(rows as Row[], runId);
		},
		async markError(runId, message, finishedAt) {
			await sql.begin(async (transaction) => {
				const existing = await transaction.unsafe(
					`SELECT ${RUN_COLUMNS} FROM task_runs WHERE run_id = $1 FOR UPDATE`,
					[runId],
				);
				requireUpdated(existing as Row[], runId);
				const row = toRecord(existing[0] as Row);
				const delivery = sealFailure(
					{ runId, specId: row.specId, output: row.output, limit: row.limitHit },
					message,
				);
				const rows = await transaction.unsafe(
					"UPDATE task_runs SET status = 'error', error_message = $1, finished_at = to_timestamp($2 / 1000.0), updated_at = now(), delivery_json = $4::text::jsonb WHERE run_id = $3 RETURNING run_id",
					[message, finishedAt, runId, JSON.stringify(delivery)],
				);
				requireUpdated(rows as Row[], runId);
			});
		},
		async markStale(runId, message, finishedAt) {
			return await sql.begin(async (transaction) => {
				const rows = await transaction.unsafe(
					`SELECT ${RUN_COLUMNS} FROM task_runs WHERE run_id=$1 AND status IN ('queued','running') FOR UPDATE`,
					[runId],
				);
				if (!rows.length) return false;
				const row = toRecord(rows[0] as Row);
				const delivery = sealFailure(
					{ runId, specId: row.specId, output: row.output, limit: row.limitHit },
					message,
				);
				await transaction.unsafe(
					"UPDATE task_runs SET status='error',error_message=$1,finished_at=to_timestamp($2 / 1000.0),delivery_json=$3::text::jsonb,updated_at=now() WHERE run_id=$4",
					[message, finishedAt, JSON.stringify(delivery), runId],
				);
				return true;
			});
		},
		async deleteRun(runId) {
			await sql.unsafe("DELETE FROM task_runs WHERE run_id = $1", [runId]);
		},
		async recoverStaleRuns(now) {
			return await sql.begin(async (transaction) => {
				const rows = await transaction.unsafe(
					`SELECT ${RUN_COLUMNS} FROM task_runs WHERE status IN ('queued','running') FOR UPDATE`,
				);
				for (const raw of rows) {
					const row = toRecord(raw as Row);
					const delivery = sealFailure(
						{ runId: row.runId, specId: row.specId, output: row.output, limit: row.limitHit },
						"process restarted",
					);
					await transaction.unsafe(
						"UPDATE task_runs SET status='error',error_message='process restarted',finished_at=to_timestamp($1 / 1000.0),updated_at=now(),delivery_json=$2::text::jsonb WHERE run_id=$3",
						[now, JSON.stringify(delivery), row.runId],
					);
				}
				return rows.length;
			});
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
