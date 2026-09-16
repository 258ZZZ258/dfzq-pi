import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createDefaultRuntimeFactory } from "../src/server/main.ts";
import { createWorkerFactory } from "../src/worker/factory.ts";
import { startMockOpenAiServer } from "./fixtures/mock-openai-server.mjs";

it.each([1, 2, 3, -1, -2, -3])(
	"production factory enforces %s total turns including escalation and output repair",
	async (maxTurns) => {
		const isolated = maxTurns < 0;
		maxTurns = Math.abs(maxTurns);
		const root = await mkdtemp(join(tmpdir(), "factory-turns-"));
		const mock = await startMockOpenAiServer({ finalText: "not valid JSON" });
		vi.stubEnv("LOCAL_TURN_TEST_KEY", "local-only");
		try {
			const specsDir = join(root, "specs");
			await mkdir(specsDir);
			await writeFile(join(specsDir, "system.md"), "Synthetic test");
			await writeFile(
				join(specsDir, "answer.schema"),
				JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }),
			);
			await writeFile(
				join(root, "profile.json"),
				JSON.stringify({
					id: "local",
					baseUrl: mock.baseUrl,
					apiKeyEnv: "LOCAL_TURN_TEST_KEY",
					api: "openai-completions",
					roles: {
						main: {
							provider: "local-test",
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
					toolset: "synthetic",
					tools: ["search_policy", "get_clause_detail"],
					limits: { maxTurns, runTimeoutMs: 5000 },
					outputContract: { schema: "answer.schema", maxRepairAttempts: 10 },
					fastPath: {
						enabled: true,
						systemPrompt: "system.md",
						rewritePrompt: "system.md",
						answerPrompt: "system.md",
						maxClauses: 1,
						limits: { runTimeoutMs: 5000 },
					},
					mcpServers: [
						{
							id: "empty",
							command: process.execPath,
							args: [fileURLToPath(new URL("./fixtures/empty-search-mcp.mjs", import.meta.url))],
							env: {},
						},
					],
				}),
			);
			const factory = await (isolated ? createWorkerFactory : createDefaultRuntimeFactory)({
				profilePath: join(root, "profile.json"),
				specsDir,
				workRoot: join(root, "runs"),
			});
			const runtime = await factory({
				specId: "demo",
				sessionId: "s",
				runId: "r",
				filters: { corpusTypes: ["internal"] },
				options: {},
			});
			try {
				const result = await runtime.run("synthetic request", { runId: "r" });
				expect(result).toMatchObject({ status: "limit_exceeded", limit: "maxTurns", turns: maxTurns });
				expect(result.answer).toBeUndefined();
				expect(mock.requests).toHaveLength(maxTurns);
			} finally {
				await runtime.dispose();
			}
		} finally {
			vi.unstubAllEnvs();
			await mock.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
