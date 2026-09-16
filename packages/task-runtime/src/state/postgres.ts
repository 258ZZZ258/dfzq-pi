import postgres from "postgres";
import { canonicalJson } from "./json.ts";
import type { StateStore } from "./store.ts";

export function createPostgresStateStore(dsn: string): StateStore {
	if (!dsn) throw new Error("state database DSN is required");
	const sql = postgres(dsn, { max: 10, connect_timeout: 10, connection: { statement_timeout: 15000 } });
	return {
		async scan(prefix, after, limit) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("scan_limit_invalid");
			const rows =
				await sql`SELECT state_key,value_json FROM agent_state WHERE state_key >= ${prefix} AND state_key < ${`${prefix}\uffff`} AND state_key > ${after} ORDER BY state_key LIMIT ${limit}`;
			return rows.map((row) => ({ key: String(row.state_key), value: row.value_json }));
		},
		async get(key) {
			const rows = await sql`SELECT revision,value_json FROM agent_state WHERE state_key=${key}`;
			return rows.length ? { revision: Number(rows[0].revision), value: rows[0].value_json } : undefined;
		},
		async compareAndSwap(key, revision, value) {
			const json = canonicalJson(value);
			if (json === undefined) throw new Error("state must be JSON serializable");
			const rows =
				revision === null
					? await sql`INSERT INTO agent_state(state_key,revision,value_json) VALUES (${key},1,${json}::jsonb) ON CONFLICT(state_key) DO NOTHING RETURNING revision`
					: await sql`UPDATE agent_state SET revision=revision+1,value_json=${json}::jsonb WHERE state_key=${key} AND revision=${revision} RETURNING revision`;
			return rows.length === 1;
		},
		async close() {
			await sql.end({ timeout: 5 });
		},
	};
}
