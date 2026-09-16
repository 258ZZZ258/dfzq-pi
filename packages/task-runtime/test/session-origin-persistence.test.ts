import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Gate } from "../src/server/gate.ts";
import { RunManager } from "../src/server/run-manager.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it.each([true, false])("preserves session origin=%s across store reopen and manager replacement", async (explicit) => {
	const dir = await mkdtemp(join(tmpdir(), "session-origin-"));
	const path = join(dir, "runs.db");
	let store = createSqliteRunStore(path);
	try {
		const req = {
			taskKind: "demo",
			specId: "demo",
			input: "hello",
			clientRequestId: "k",
			sessionId: "s1",
			sessionIdExplicit: explicit,
			filters: { corpusTypes: ["internal"] },
		};
		const runtime = createStubRuntime();
		const firstManager = new RunManager({ store, gate: new Gate(), runtimeFactory: async () => runtime });
		const first = await firstManager.submit(req);
		if (first.kind !== "accepted") throw new Error("expected accepted");
		await first.completion;
		store.close();
		store = createSqliteRunStore(path);
		expect(store.findByRunId(first.runId)?.sessionIdExplicit).toBe(explicit);
		const next = new RunManager({ store, gate: new Gate(), runtimeFactory: async () => runtime });
		expect(await next.submit({ ...req, sessionId: explicit ? "s1" : "new-generated" })).toMatchObject({
			kind: "idempotent",
			runId: first.runId,
		});
		expect(await next.submit({ ...req, sessionIdExplicit: !explicit })).toEqual({ kind: "idempotency_conflict" });
		expect(runtime.runCalls).toBe(1);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("migrates an old SQLite table without inventing session-origin metadata", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-legacy-"));
	const path = join(dir, "runs.db");
	let store = createSqliteRunStore(path);
	try {
		store.insertQueued({
			runId: "old",
			clientRequestId: "k",
			sessionId: "s",
			specId: "demo",
			taskKind: "demo",
			input: "hello",
			filtersJson: '{"corpusTypes":["internal"]}',
			createdAt: 1,
		});
		store.close();
		const db = new DatabaseSync(path);
		try {
			db.exec("ALTER TABLE runs DROP COLUMN session_id_explicit");
		} finally {
			db.close();
		}
		store = createSqliteRunStore(path);
		expect(store.findByRunId("old")?.sessionIdExplicit).toBeUndefined();
		const manager = new RunManager({ store, gate: new Gate(), runtimeFactory: async () => createStubRuntime() });
		expect(
			await manager.submit({
				taskKind: "demo",
				specId: "demo",
				input: "hello",
				clientRequestId: "k",
				sessionId: "new",
				sessionIdExplicit: false,
				filters: { corpusTypes: ["internal"] },
			}),
		).toEqual({ kind: "idempotency_conflict" });
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
