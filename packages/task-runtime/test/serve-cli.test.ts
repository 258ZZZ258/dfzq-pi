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

	it("serves a real request end to end", { timeout: CASE_TIMEOUT_MS }, async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, [CLI, "serve"], {
			env: { ...baseEnv(), TASK_RUNTIME_INTERNAL_TOKEN: "secret" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		try {
			const port = await new Promise<number>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("serve did not report a port")), EXEC_TIMEOUT_MS);
				let buffered = "";
				child.stderr.on("data", (chunk: Buffer) => {
					buffered += chunk.toString();
					const match = /listening on (\d+)/.exec(buffered);
					if (!match) return;
					clearTimeout(timer);
					resolve(Number(match[1]));
				});
			});

			const unauthorized = await fetch(`http://127.0.0.1:${port}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					taskKind: "demo",
					input: "hi",
					clientRequestId: "c1",
					filters: { corpusTypes: ["internal"] },
				}),
			});
			expect(unauthorized.status).toBe(401);

			const authorized = await fetch(`http://127.0.0.1:${port}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-internal-token": "secret" },
				body: JSON.stringify({
					taskKind: "demo",
					input: "hi",
					clientRequestId: "c2",
					filters: { corpusTypes: ["internal"] },
				}),
			});
			// 装配会因为 profile 指向一个不存在的 baseUrl 而失败 —— 这里断言的是**接线通了**:
			// 请求被受理、进了 RunManager,而不是被鉴权或路由挡掉。
			expect([200, 202]).toContain(authorized.status);
		} finally {
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("exit", resolve));
		}
	});
});
