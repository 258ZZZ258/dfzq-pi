import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./json.ts";

export interface StateRecord {
	revision: number;
	value: unknown;
}
/** Atomic, durable CAS port. Tombstones retain revisions to prevent ABA. */
export interface StateStore {
	scan?(prefix: string, after: string, limit: number): Promise<Array<{ key: string; value: unknown }>>;
	get(key: string): Promise<StateRecord | undefined>;
	compareAndSwap(key: string, revision: number | null, value: unknown): Promise<boolean>;
	close(): Promise<void>;
}

export function createSqliteStateStore(path: string): StateStore {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout=5000");
	db.exec("PRAGMA journal_mode=WAL");
	db.exec(
		"CREATE TABLE IF NOT EXISTS agent_state (state_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL)",
	);
	const read = db.prepare("SELECT revision, value_json FROM agent_state WHERE state_key=?");
	const insert = db.prepare(
		"INSERT INTO agent_state(state_key,revision,value_json) VALUES (?,1,?) ON CONFLICT(state_key) DO NOTHING",
	);
	const update = db.prepare(
		"UPDATE agent_state SET revision=revision+1,value_json=? WHERE state_key=? AND revision=?",
	);
	let closed = false;
	return {
		async scan(prefix, after, limit) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("scan_limit_invalid");
			return (
				db
					.prepare(
						"SELECT state_key,value_json FROM agent_state WHERE state_key >= ? AND state_key < ? AND state_key > ? ORDER BY state_key LIMIT ?",
					)
					.all(prefix, `${prefix}\uffff`, after, limit) as Array<{ state_key: string; value_json: string }>
			).map((row) => ({ key: row.state_key, value: JSON.parse(row.value_json) }));
		},
		async get(key) {
			const row = read.get(key) as { revision: number; value_json: string } | undefined;
			return row ? { revision: row.revision, value: JSON.parse(row.value_json) } : undefined;
		},
		async compareAndSwap(key, revision, value) {
			const json = canonicalJson(value);
			if (json === undefined) throw new Error("state must be JSON serializable");
			return (
				Number(revision === null ? insert.run(key, json).changes : update.run(json, key, revision).changes) === 1
			);
		},
		async close() {
			if (!closed) {
				closed = true;
				db.close();
			}
		},
	};
}
