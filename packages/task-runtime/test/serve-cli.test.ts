import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const EXEC_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-serve-"));
	await mkdir(join(root, "specs"));
	await writeFile(
		join(root, "specs", "demo.json"),
		JSON.stringify({ id: "demo", model: { role: "main" }, toolset: "t", tools: ["a"], limits: { maxTurns: 3 } }),
	);
	await writeFile(
		join(root, "profile.json"),
		JSON.stringify({
			id: "p",
			baseUrl: "http://127.0.0.1:1",
			apiKeyEnv: "SERVE_TEST_KEY",
			api: "openai-completions",
			roles: {
				main: {
					provider: "x",
					modelId: "m",
					contextWindow: 1000,
					maxTokens: 100,
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			},
		}),
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const baseEnv = () => ({
	...process.env,
	TASK_RUNTIME_PORT: "0",
	TASK_RUNTIME_DB_PATH: join(root, "runs.db"),
	TASK_RUNTIME_SPECS_DIR: join(root, "specs"),
	TASK_RUNTIME_PROFILE: join(root, "profile.json"),
	TASK_RUNTIME_WORK_ROOT: join(root, "work"),
	SERVE_TEST_KEY: "k",
});

describe("serve subcommand", () => {
	it("refuses to start without an internal token", { timeout: CASE_TIMEOUT_MS }, async () => {
		const env = baseEnv();
		delete (env as Record<string, string | undefined>).TASK_RUNTIME_INTERNAL_TOKEN;
		await expect(run(process.execPath, [CLI, "serve"], { env, timeout: EXEC_TIMEOUT_MS })).rejects.toMatchObject({
			stderr: expect.stringContaining("TASK_RUNTIME_INTERNAL_TOKEN"),
		});
	});

	it("refuses to start with an empty internal token", { timeout: CASE_TIMEOUT_MS }, async () => {
		const env = { ...baseEnv(), TASK_RUNTIME_INTERNAL_TOKEN: "" };
		await expect(run(process.execPath, [CLI, "serve"], { env, timeout: EXEC_TIMEOUT_MS })).rejects.toMatchObject({
			stderr: expect.stringContaining("TASK_RUNTIME_INTERNAL_TOKEN"),
		});
	});

	it(
		"rejects retired SQLite CLI configuration when the PostgreSQL DSN is missing",
		{ timeout: CASE_TIMEOUT_MS },
		async () => {
			const env: NodeJS.ProcessEnv = { ...baseEnv(), TASK_RUNTIME_INTERNAL_TOKEN: "secret" };
			delete env.PIPELINE_DB_DSN;
			await expect(run(process.execPath, [CLI, "serve"], { env, timeout: EXEC_TIMEOUT_MS })).rejects.toMatchObject({
				stderr: expect.stringContaining("PIPELINE_DB_DSN"),
			});
		},
	);
});
