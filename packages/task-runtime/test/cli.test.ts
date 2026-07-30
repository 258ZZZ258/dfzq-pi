import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startMockOpenAiServer } from "./fixtures/mock-openai-server.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

let root: string;
let mockServer: Awaited<ReturnType<typeof startMockOpenAiServer>> | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	// mock server 必须显式 close():listen(0) 拿的是随机端口,不关就是残留监听 —— 违反本任务的
	// 硬约束("测试跑完无残留子进程、无残留监听端口")。
	if (mockServer) {
		await mockServer.close();
		mockServer = undefined;
	}
});

describe("cli", () => {
	it("exits non-zero with a readable error when the spec file is missing", async () => {
		await expect(run(process.execPath, [CLI, "run", "--spec", "/nope.json", "--input", "hi"])).rejects.toMatchObject({
			code: 1,
		});
	});

	it("reports the missing api key env var by name", async () => {
		root = await mkdtemp(join(tmpdir(), "cli-"));
		const specPath = join(root, "spec.json");
		const profilePath = join(root, "profile.json");
		await writeFile(
			specPath,
			JSON.stringify({
				id: "demo",
				model: { role: "main" },
				toolset: "mcp",
				tools: ["echo"],
				limits: { maxTurns: 3 },
				mcpServers: [{ id: "echo", command: process.execPath, args: [SERVER], env: {} }],
			}),
		);
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "test",
				baseUrl: "http://localhost/v1",
				apiKeyEnv: "DFZQ_ABSENT_KEY",
				api: "openai-completions",
				roles: {
					main: {
						provider: "p",
						modelId: "m",
						contextWindow: 8192,
						maxTokens: 1024,
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);
		await expect(
			run(process.execPath, [
				CLI,
				"run",
				"--spec",
				specPath,
				"--profile",
				profilePath,
				"--workdir",
				root,
				"--input",
				"hi",
			]),
		).rejects.toMatchObject({ stderr: expect.stringContaining("DFZQ_ABSENT_KEY") });
	});

	// Task 15:补齐 CLI 的成功路径。CLI 是 execFile spawn 出的子进程,createFauxHarness()
	// patch 的是父进程内的 pi-ai api-registry,子进程看不到 —— 所以这里用一个真实的本地 HTTP
	// server(mock-openai-server.mjs)充当 profile.json 指向的 OpenAI 兼容端点,让子进程真的
	// 拨得通。同一次 run 里覆盖三条断言:① RunResult 合法且 completed ② EVAL_TASK_LOG 传到了
	// MCP 子进程(带完整的工具调用往返,不是退路)③ trajectory 落盘且含 turn_end。
	it("runs a task to completion: valid RunResult, EVAL_TASK_LOG reaches the MCP child, trajectory has turn_end", async () => {
		mockServer = await startMockOpenAiServer({
			toolCall: { name: "echo", arguments: { text: "hello from tool call" } },
		});

		root = await mkdtemp(join(tmpdir(), "cli-success-"));
		const specPath = join(root, "spec.json");
		const profilePath = join(root, "profile.json");
		const trajectoryPath = join(root, "trajectory.jsonl");
		const evalTaskLogPath = join(root, "eval-task-log.jsonl");

		await writeFile(
			specPath,
			JSON.stringify({
				id: "demo",
				model: { role: "main" },
				toolset: "mcp",
				tools: ["echo"],
				limits: { maxTurns: 5 },
				mcpServers: [{ id: "echo", command: process.execPath, args: [SERVER], env: {} }],
			}),
		);
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "test",
				baseUrl: mockServer.baseUrl,
				apiKeyEnv: "DFZQ_TEST_KEY",
				api: "openai-completions",
				roles: {
					main: {
						provider: "mock",
						modelId: "mock-model",
						contextWindow: 8192,
						maxTokens: 1024,
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);

		const { stdout } = await run(
			process.execPath,
			[
				CLI,
				"run",
				"--spec",
				specPath,
				"--profile",
				profilePath,
				"--workdir",
				root,
				"--input",
				"please call the echo tool",
				"--trajectory",
				trajectoryPath,
			],
			{
				env: {
					...process.env,
					DFZQ_TEST_KEY: "sk-test-unused",
					EVAL_TASK_LOG: evalTaskLogPath,
				},
			},
		);

		// mock server 真的收到了两轮请求(工具调用轮 + 收尾轮),不是靠退路蒙混过去的往返。
		expect(mockServer.requests).toHaveLength(2);

		// ① RunResult 合法且状态正确
		const lines = stdout.trim().split("\n").filter(Boolean);
		const result = JSON.parse(lines.at(-1) as string);
		expect(result.status).toBe("completed");
		expect(typeof result.runId).toBe("string");
		expect(result.runId.length).toBeGreaterThan(0);
		expect(result.specId).toBe("demo");
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const) {
			expect(typeof result.usage[key]).toBe("number");
		}
		expect(result.turns).toBeGreaterThanOrEqual(1);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		// ② EVAL_TASK_LOG 到达 MCP 子进程:文件存在、非空,内容是 fixture 写的工具调用日志
		const taskLogRaw = await readFile(evalTaskLogPath, "utf8");
		expect(taskLogRaw.trim().length).toBeGreaterThan(0);
		const taskLogEntries = taskLogRaw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(taskLogEntries).toContainEqual(
			expect.objectContaining({ tool: "echo", arguments: { text: "hello from tool call" } }),
		);

		// ③ trajectory 落盘:文件存在、每行合法 JSON、含 turn_end 事件
		const trajectoryRaw = await readFile(trajectoryPath, "utf8");
		const trajectoryLines = trajectoryRaw.trim().split("\n").filter(Boolean);
		expect(trajectoryLines.length).toBeGreaterThan(0);
		const trajectoryEvents = trajectoryLines.map((line) => JSON.parse(line));
		expect(trajectoryEvents.some((event) => event.type === "turn_end")).toBe(true);
	});
});
