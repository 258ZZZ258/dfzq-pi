import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { startServer } from "../src/server/main.ts";
import type { RuntimeFactory } from "../src/server/run-manager.ts";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { withDurableExecution } from "../src/state/durable-factory.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createWorkerFactory } from "../src/worker/factory.ts";
import { startMockOpenAiServer } from "./fixtures/mock-openai-server.mjs";

it("restarts the service and resumes a pending tool via Java HTTP without repeating its effect", async () => {
	const root = await mkdtemp(join(tmpdir(), "resume-http-"));
	const specsDir = join(root, "specs");
	await mkdir(specsDir);
	const logPath = join(root, "calls.jsonl");
	const statePath = join(root, "state.db");
	let state = createSqliteStateStore(statePath);
	const mock = await startMockOpenAiServer({
		toolCall: { name: "echo", arguments: { text: "test" } },
		finalText: '{"ok":true}',
	});
	vi.stubEnv("RESUME_TEST_KEY", "local");
	let close: (() => Promise<void>) | undefined;
	try {
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "local",
				baseUrl: mock.baseUrl,
				apiKeyEnv: "RESUME_TEST_KEY",
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
						env: { EVAL_TASK_LOG: logPath },
						toolEffects: { echo: "non_idempotent_write" },
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
		let failAfterTool = true;
		const controlled: RuntimeFactory = (input) =>
			base({
				...input,
				onCheckpoint: async (checkpoint) => {
					if (failAfterTool && checkpoint.next !== "pending_tools") throw new Error("simulated checkpoint outage");
					await input.onCheckpoint?.(checkpoint);
				},
			});
		const launch = () =>
			startServer({
				port: 0,
				dbPath: join(root, "history.db"),
				specsDir,
				internalToken: "test",
				runtimeFactory: withDurableExecution(controlled, new CheckpointCoordinator(state), "test-config"),
			});
		let server = await launch();
		close = server.close;
		const headers = { "content-type": "application/json", "X-Internal-Token": "test" };
		const first = (await (
			await fetch(`http://127.0.0.1:${server.port}/runs`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					taskKind: "demo",
					input: "call echo then finish",
					sessionId: "s",
					clientRequestId: "initial",
					filters: { corpusTypes: ["internal"] },
				}),
			})
		).json()) as { runId: string; status: string };
		expect(first.status).toBe("error");
		await server.close();
		await state.close();
		state = createSqliteStateStore(statePath);
		failAfterTool = false;
		server = await launch();
		close = server.close;
		const resumed = (await (
			await fetch(`http://127.0.0.1:${server.port}/runs/${first.runId}/resume`, {
				method: "POST",
				headers,
				body: JSON.stringify({ clientRequestId: "resume-1" }),
			})
		).json()) as { runId: string };
		expect(resumed.runId).not.toBe(first.runId);
		let final: { status: string; answer?: unknown; turns?: number } | undefined;
		await expect
			.poll(
				async () => {
					final = (await (
						await fetch(`http://127.0.0.1:${server.port}/runs/${resumed.runId}`, { headers })
					).json()) as typeof final;
					return final?.status;
				},
				{ timeout: 10000 },
			)
			.toBe("completed");
		expect(final?.answer).toEqual({ ok: true });
		expect(final?.turns).toBe(2);
		const calls = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { arguments: { run_id: string } });
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments.run_id).toBe(first.runId);
		expect(mock.requests).toHaveLength(2);
		const original = (await (
			await fetch(`http://127.0.0.1:${server.port}/runs/${first.runId}`, { headers })
		).json()) as { status: string };
		expect(original.status).toBe("error");
		const history = createSqliteRunStore(join(root, "history.db"));
		try {
			const events = await history.listEvents(resumed.runId);
			expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
			const checkpoint = events.find((event) => event.type === "checkpoint_saved");
			expect(checkpoint).toBeDefined();
			expect(JSON.parse(checkpoint!.payload)).toMatchObject({ checkpointSeq: expect.any(Number), fence: 2 });
			const replay = events.find(
				(event) => event.type === "tool_execution_end" && JSON.parse(event.payload).replayed,
			);
			expect(replay).toBeDefined();
			expect(JSON.parse(replay!.payload).toolCallId).toEqual(expect.any(String));
			expect(replay!.payload).not.toContain('"arguments"');
		} finally {
			await history.close();
		}
	} finally {
		await close?.();
		await state.close();
		await mock.close();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
