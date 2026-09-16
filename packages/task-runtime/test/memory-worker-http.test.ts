import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { MemoryService } from "../src/memory/service.ts";
import { startServer } from "../src/server/main.ts";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { withDurableExecution } from "../src/state/durable-factory.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { createWorkerFactory } from "../src/worker/factory.ts";
import { startMockOpenAiServer } from "./fixtures/mock-openai-server.mjs";

it("passes authorized memory into a real isolated session and stops using it after deletion", async () => {
	const root = await mkdtemp(join(tmpdir(), "memory-worker-"));
	const specsDir = join(root, "specs");
	await mkdir(specsDir);
	const statePath = join(root, "state.db");
	const state = createSqliteStateStore(statePath);
	const memory = new MemoryService(state);
	const mock = await startMockOpenAiServer({ finalText: '{"ok":true}' });
	vi.stubEnv("MEMORY_WORKER_KEY", "local");
	let close: (() => Promise<void>) | undefined;
	try {
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "local",
				baseUrl: mock.baseUrl,
				apiKeyEnv: "MEMORY_WORKER_KEY",
				api: "openai-completions",
				roles: {
					main: {
						provider: "local",
						modelId: "mock-model",
						contextWindow: 8192,
						maxTokens: 1024,
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);
		await writeFile(
			join(specsDir, "schema.data"),
			JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }),
		);
		await writeFile(
			join(specsDir, "demo.json"),
			JSON.stringify({
				id: "demo",
				model: { role: "main" },
				toolset: "demo",
				tools: ["echo"],
				limits: { maxTurns: 5, runTimeoutMs: 5000 },
				outputContract: { schema: "schema.data" },
				mcpServers: [
					{
						id: "echo",
						command: process.execPath,
						args: [fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url))],
						env: {},
						toolEffects: { echo: "read" },
					},
				],
			}),
		);
		const base = await createWorkerFactory({
			profilePath,
			specsDir,
			workRoot: join(root, "runs"),
			state: { kind: "sqlite", path: statePath },
		});
		const server = await startServer({
			port: 0,
			dbPath: join(root, "history.db"),
			specsDir,
			internalToken: "test",
			memory,
			runtimeFactory: withDurableExecution(base, new CheckpointCoordinator(state), "config"),
		});
		close = server.close;
		const url = `http://127.0.0.1:${server.port}`;
		const headers = {
			"content-type": "application/json",
			"x-internal-token": "test",
			"x-tenant-id": "t",
			"x-user-id": "u",
		};
		const created = (await (
			await fetch(`${url}/memories`, {
				method: "POST",
				headers,
				body: JSON.stringify({ requestId: "m1", category: "preference", text: "请使用简洁中文回答" }),
			})
		).json()) as { item: { id: string; revision: number } };
		const run = async (key: string) =>
			(await (
				await fetch(`${url}/runs`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						taskKind: "demo",
						clientRequestId: key,
						sessionId: key,
						input: "介绍Agent",
						filters: { corpusTypes: ["internal"] },
					}),
				})
			).json()) as { runId: string; status: string; memoryObservation?: { status: string; ids: string[] } };
		const first = await run("first");
		expect(first.status).toBe("completed");
		expect(first.memoryObservation).toMatchObject({ status: "used", ids: [created.item.id] });
		expect(JSON.stringify(mock.requests[0])).toContain("请使用简洁中文回答");
		expect(
			(await fetch(`${url}/runs/${first.runId}`, { headers: { ...headers, "x-user-id": "other" } })).status,
		).toBe(403);
		expect(
			(
				await fetch(`${url}/runs/${first.runId}/resume`, {
					method: "POST",
					headers: { ...headers, "x-user-id": "other" },
					body: JSON.stringify({ clientRequestId: "bad" }),
				})
			).status,
		).toBe(403);
		await fetch(`${url}/memories/${created.item.id}/delete`, {
			method: "POST",
			headers,
			body: JSON.stringify({ revision: created.item.revision }),
		});
		const second = await run("second");
		expect(second.memoryObservation?.status).toBe("empty");
		expect(JSON.stringify(mock.requests[1])).not.toContain("请使用简洁中文回答");
	} finally {
		await close?.();
		await state.close();
		await mock.close();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
