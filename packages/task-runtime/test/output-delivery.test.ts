import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startServer } from "../src/server/main.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it.each(["broken", "shape", "identity", "array", "text"] as const)(
	"enforces %s output before storage and across HTTP replay",
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "output-delivery-"));
		const dbPath = join(root, "history.db");
		let close: (() => Promise<void>) | undefined;
		try {
			await writeFile(
				join(root, "schema.data"),
				JSON.stringify({
					type: "array",
					items: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
				}),
			);
			await writeFile(
				join(root, "demo.json"),
				JSON.stringify({
					id: "demo",
					model: { role: "main" },
					toolset: "demo",
					tools: ["echo"],
					limits: { maxTurns: 5 },
					...(mode === "text" ? {} : { outputContract: { schema: "schema.data" } }),
				}),
			);
			const output = mode === "array" ? '[{"ok":true}]' : mode === "shape" ? '{"ok":true}' : "plain text";
			const stub = createStubRuntime({
				result: { output, answer: { injected: true }, ...(mode === "identity" ? { specId: "unknown" } : {}) },
			});
			const server = await startServer({
				port: 0,
				dbPath,
				specsDir: root,
				internalToken: "test",
				runtimeFactory: async () => stub,
			});
			close = server.close;
			const url = `http://127.0.0.1:${server.port}`;
			const headers = { "X-Internal-Token": "test", "content-type": "application/json" };
			const body = { taskKind: "demo", input: "q", clientRequestId: "k", filters: { corpusTypes: ["internal"] } };
			const submit = () => fetch(`${url}/runs`, { method: "POST", headers, body: JSON.stringify(body) });
			const response = await submit();
			expect(response.status).toBe(200);
			const first = (await response.json()) as {
				runId: string;
				status: string;
				answer?: unknown;
				errorMessage?: string;
				delivery?: unknown;
			};
			const success = mode === "array" || mode === "text";
			expect(first.status).toBe(success ? "completed" : "error");
			expect(first.answer).toEqual(mode === "array" ? [{ ok: true }] : undefined);
			const store = createSqliteRunStore(dbPath);
			try {
				expect(store.findByRunId(first.runId)?.status).toBe(first.status);
			} finally {
				store.close();
			}
			const fetched = (await (await fetch(`${url}/runs/${first.runId}`, { headers })).json()) as typeof first;
			const replayed = (await (await submit()).json()) as typeof first;
			for (const value of [fetched, replayed]) {
				expect(value.status).toBe(first.status);
				expect(value.answer).toEqual(first.answer);
				expect(value.delivery).toEqual(first.delivery);
			}
			expect(stub.runCalls).toBe(1);
		} finally {
			await close?.();
			await rm(root, { recursive: true, force: true });
		}
	},
);
