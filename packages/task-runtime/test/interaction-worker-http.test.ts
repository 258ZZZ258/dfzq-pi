import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { SessionInbox } from "../src/interaction/inbox.ts";
import { startServer } from "../src/server/main.ts";
import type { RuntimeFactory } from "../src/server/run-manager.ts";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { withDurableExecution } from "../src/state/durable-factory.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { createWorkerFactory } from "../src/worker/factory.ts";
import { javaGrantFixture } from "./helpers/java-grant.ts";

it.each(["live", "restart-before-checkpoint", "restart-after-checkpoint"] as const)(
	"%s: durable steering and independent follow-up preserve conversation",
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "interactive-pi-")),
			specsDir = join(root, "specs"),
			statePath = join(root, "state.db");
		await mkdir(specsDir);
		let state = createSqliteStateStore(statePath),
			inbox = new SessionInbox(state);
		const java = javaGrantFixture();
		const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
		let release!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const model = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				void (async () => {
					const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
					requests.push(body);
					if (requests.length === 1) await firstGate;
					res.writeHead(200, { "content-type": "text/event-stream" });
					const base = {
						id: "test",
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
					};
					res.write(
						`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: '{"ok":true}' }, finish_reason: null }] })}\n\n`,
					);
					res.end(
						`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
					);
				})().catch(() => res.destroy());
			});
		});
		await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
		const address = model.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "local",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnv: "INTERACTION_TEST_KEY",
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
			join(specsDir, "demo.json"),
			JSON.stringify({
				id: "demo",
				model: { role: "main" },
				toolset: "empty",
				tools: ["echo"],
				mcpServers: [
					{
						id: "echo",
						command: process.execPath,
						args: [fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url))],
						env: {},
						toolEffects: { echo: "read" },
					},
				],
				limits: { maxTurns: 5, runTimeoutMs: 10000 },
				outputContract: { schema: "schema.data" },
			}),
		);
		await writeFile(
			join(specsDir, "schema.data"),
			JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }),
		);
		vi.stubEnv("INTERACTION_TEST_KEY", "local-test");
		const baseFactory = await createWorkerFactory({
			profilePath,
			specsDir,
			workRoot: join(root, "runs"),
			state: { kind: "sqlite", path: statePath },
		});
		let injected = false;
		const controlled: RuntimeFactory = (input) =>
			baseFactory({
				...input,
				onCheckpoint: async (checkpoint) => {
					if (
						mode === "restart-before-checkpoint" &&
						!injected &&
						(checkpoint.pluginState?.consumedMessageIds as string[] | undefined)?.length
					) {
						injected = true;
						throw new Error("simulated loss before checkpoint commit");
					}
					await input.onCheckpoint?.(checkpoint);
					if (
						mode === "restart-after-checkpoint" &&
						!injected &&
						(checkpoint.pluginState?.consumedMessageIds as string[] | undefined)?.length
					) {
						injected = true;
						throw new Error("simulated loss after checkpoint commit");
					}
				},
			});
		const launch = () =>
			startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir,
				internalToken: "test",
				grants: java.verifier,
				inbox,
				runtimeFactory: withDurableExecution(controlled, new CheckpointCoordinator(state), "test-config"),
			});
		let server = await launch();
		const request = (path: string, method = "GET", body?: unknown) =>
			fetch(`http://127.0.0.1:${server.port}${path}`, {
				method,
				headers: {
					"content-type": "application/json",
					"x-internal-token": "test",
					authorization: `Bearer ${java.token()}`,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		try {
			const first = (await (
				await request("/runs", "POST", {
					taskKind: "demo",
					sessionId: "s1",
					input: "initial question",
					clientRequestId: "initial",
					filters: { corpusTypes: ["internal"] },
					waitMs: 0,
				})
			).json()) as { runId: string };
			await expect
				.poll(
					async () => {
						if (requests.length) return requests.length;
						const status = (await (await request(`/runs/${first.runId}`)).json()) as {
							status: string;
							errorMessage?: string;
						};
						return status.status === "error" ? status.errorMessage : 0;
					},
					{ timeout: 10000 },
				)
				.toBe(1);
			const steer = { kind: "steer", clientMessageId: "steer-1", targetRunId: first.runId, text: "STEER_SENTINEL" };
			const accepted = await request("/sessions/s1/messages", "POST", steer);
			expect(accepted.status).toBe(202);
			const receipt = (await accepted.json()) as { messageId: string; status: string };
			expect(receipt.status).toBe("queued");
			expect(
				((await (await request("/sessions/s1/messages", "POST", steer)).json()) as { messageId: string }).messageId,
			).toBe(receipt.messageId);
			if (mode === "live")
				expect(
					(
						await request("/sessions/s1/messages", "POST", {
							kind: "follow_up",
							clientMessageId: "follow-1",
							afterRunId: first.runId,
							text: "FOLLOWUP_SENTINEL",
						})
					).status,
				).toBe(202);
			release();
			let completedRun = first.runId;
			if (mode !== "live") {
				await expect
					.poll(
						async () => ((await (await request(`/runs/${first.runId}`)).json()) as { status: string }).status,
						{ timeout: 15000 },
					)
					.not.toBe("running");
				expect(injected).toBe(true);
				await server.close();
				await state.close();
				state = createSqliteStateStore(statePath);
				inbox = new SessionInbox(state);
				server = await launch();
				const resumed = (await (
					await request(`/runs/${first.runId}/resume`, "POST", { clientRequestId: "resume" })
				).json()) as { runId: string };
				completedRun = resumed.runId;
			}
			await expect
				.poll(async () => ((await (await request(`/runs/${completedRun}`)).json()) as { status: string }).status, {
					timeout: 15000,
				})
				.toBe("completed");
			if (mode !== "live")
				expect(
					(
						await request("/sessions/s1/messages", "POST", {
							kind: "follow_up",
							clientMessageId: "follow-1",
							afterRunId: completedRun,
							text: "FOLLOWUP_SENTINEL",
						})
					).status,
				).toBe(202);
			let nextRun = "";
			await expect
				.poll(
					async () => {
						const messages = await inbox.messages(java.claims);
						nextRun = messages.find((m) => m.kind === "follow_up")?.runId ?? "";
						return nextRun;
					},
					{ timeout: 10000 },
				)
				.not.toBe("");
			await expect
				.poll(async () => ((await (await request(`/runs/${nextRun}`)).json()) as { status: string }).status, {
					timeout: 10000,
				})
				.toBe("completed");
			expect(nextRun).not.toBe(first.runId);
			const nextResult = (await (await request(`/runs/${nextRun}`)).json()) as {
				turns: number;
				usage: { total: number };
			};
			expect(nextResult.turns).toBe(1);
			expect(nextResult.usage.total).toBe(2);
			expect(requests).toHaveLength(3);
			expect(JSON.stringify(requests.at(-1))).toContain("initial question");
			expect(JSON.stringify(requests.at(-1)).match(/STEER_SENTINEL/g)).toHaveLength(1);
			expect(JSON.stringify(requests.at(-1))).toContain("FOLLOWUP_SENTINEL");
			expect((await inbox.messages(java.claims)).map((m) => m.status)).toEqual(["consumed", "consumed"]);
			expect((await request("/sessions/s1/messages", "POST", { ...steer, clientMessageId: "late" })).status).toBe(
				409,
			);
		} finally {
			release();
			await server.close();
			await state.close();
			await new Promise<void>((resolve) => model.close(() => resolve()));
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	},
	40000,
);
