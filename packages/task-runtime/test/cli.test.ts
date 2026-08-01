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

/**
 * 每个 execFile 都必须带 timeout,否则 CLI 一旦死锁,子进程会活过 vitest 的 test timeout
 * —— vitest 判超时只是让这条用例失败,不会去杀它 spawn 出来的进程,CI 里就开始攒孤儿进程。
 * 本分支为"不留孤儿进程"专门给 McpClient 加了 SIGKILL 升级,不能被自己的测试破功。
 *
 * 取值:最慢的用例实测 ~0.7s,这里给到 30s 是纯粹的安全网(不制造 flake);配套的
 * CASE_TIMEOUT_MS 比它大,保证 execFile 先把子进程杀掉,而不是 vitest 先放弃、把进程漏掉。
 */
const EXEC_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

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
	it("exits non-zero with a readable error when the spec file is missing", { timeout: CASE_TIMEOUT_MS }, async () => {
		await expect(
			run(process.execPath, [CLI, "run", "--spec", "/nope.json", "--input", "hi"], { timeout: EXEC_TIMEOUT_MS }),
		).rejects.toMatchObject({ code: 1 });
	});

	it("reports the missing api key env var by name", { timeout: CASE_TIMEOUT_MS }, async () => {
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
			run(
				process.execPath,
				[CLI, "run", "--spec", specPath, "--profile", profilePath, "--workdir", root, "--input", "hi"],
				{ timeout: EXEC_TIMEOUT_MS },
			),
		).rejects.toMatchObject({ stderr: expect.stringContaining("DFZQ_ABSENT_KEY") });
	});

	// Task 15d 复审 Critical-2 的 CLI 半边回归锁:resolveSpecPromptPaths(现在是
	// src/spec/resolve-prompt-paths.ts,cli/main.ts 与 server/main.ts 共用同一份实现)在
	// cli/main.ts 里的调用点(main.ts 里紧跟在 outputContractSchema 之后那一行)此前**零覆盖**
	// ——re-reviewer 的实测:把那一行换成注释,`npm test --workspace=@dfzq/task-runtime` 一条
	// 不红,与上一轮审查抽模块前的数字一模一样。抽模块只降低了 server/cli 两份实现漂移的风险,
	// 不等于把 CLI 这一半的调用点接住了——这条补的正是"调用点本身有没有被真的执行"这件事,
	// 不是"函数体对不对"(函数体已经被 test/server-startup.test.ts 与
	// test/policy-query-spec.test.ts 的用例覆盖)。
	//
	// resolveSpecPromptPaths 跑在 toolset 装配 / MCP 握手 / 模型解析之前(main.ts 里先读
	// outputContractSchema,再解析 systemPrompt/appendSystemPrompt,toolsets 与
	// createSessionRuntime 都在后面)——所以这条用例不需要真实 MCP server、不需要有效的 API
	// key,systemPrompt 读不到应该在那之前就响亮失败、非零退出。
	it(
		"exits non-zero and names the field when spec.systemPrompt cannot be read",
		{ timeout: CASE_TIMEOUT_MS },
		async () => {
			root = await mkdtemp(join(tmpdir(), "cli-bad-system-prompt-"));
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
					systemPrompt: "missing-system-prompt.md",
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
				run(
					process.execPath,
					[CLI, "run", "--spec", specPath, "--profile", profilePath, "--workdir", root, "--input", "hi"],
					{ timeout: EXEC_TIMEOUT_MS },
				),
			).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("systemPrompt") });
		},
	);

	// Task 15:补齐 CLI 的成功路径。CLI 是 execFile spawn 出的子进程,createFauxHarness()
	// patch 的是父进程内的 pi-ai api-registry,子进程看不到 —— 所以这里用一个真实的本地 HTTP
	// server(mock-openai-server.mjs)充当 profile.json 指向的 OpenAI 兼容端点,让子进程真的
	// 拨得通。同一次 run 里覆盖三条断言:① RunResult 合法且 completed ② EVAL_TASK_LOG 传到了
	// MCP 子进程(带完整的工具调用往返,不是退路)③ trajectory 落盘且含 turn_end。
	it(
		"runs a task to completion: valid RunResult, EVAL_TASK_LOG reaches the MCP child, trajectory has turn_end",
		{ timeout: CASE_TIMEOUT_MS },
		async () => {
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
					// 这条用例会真的 spawn 出 MCP 子进程:CLI 死锁时没有 timeout 就是 CI 里的孤儿进程。
					timeout: EXEC_TIMEOUT_MS,
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
		},
	);

	// 审查 Important-2 的回归锁:此前这条 CLI 路径从不读 outputContract.schema、也不传
	// outputContractSchema —— eval/drive.ts 正是 spawn 这个文件跑评测,声明了 outputContract
	// 的 spec 经这条路径跑会让 C6 静默不挂。这里用真实子进程 + 真实 schema 文件证明:
	// ① schema 真的从磁盘读出来了(相对 --spec 所在目录解析)② 真的传给了 createSessionRuntime
	// ③ C6 真的被挂上、真的会拒绝不合 schema 的回答。maxRepairAttempts:0 让首次失败直接
	// onExhausted:"error",不需要第二轮模型往返 —— mockServer.requests 长度顺带验证了这点。
	it(
		"reads outputContract.schema relative to the spec file and lets C6 reject a non-conforming answer",
		{ timeout: CASE_TIMEOUT_MS },
		async () => {
			mockServer = await startMockOpenAiServer({ finalText: "这是一段没有 JSON 的散文" });

			root = await mkdtemp(join(tmpdir(), "cli-c6-"));
			const specPath = join(root, "spec.json");
			const profilePath = join(root, "profile.json");

			// schema 文件与 spec 文件同目录 —— 与 OutputContractSpec.schema 的字段文档
			// ("相对 spec 文件所在目录")一致。
			await writeFile(
				join(root, "answer.schema.json"),
				JSON.stringify({
					type: "object",
					required: ["conclusion"],
					properties: { conclusion: { type: "string" } },
				}),
			);
			await writeFile(
				specPath,
				JSON.stringify({
					id: "demo",
					model: { role: "main" },
					toolset: "mcp",
					tools: ["echo"],
					limits: { maxTurns: 5 },
					mcpServers: [{ id: "echo", command: process.execPath, args: [SERVER], env: {} }],
					outputContract: { schema: "answer.schema.json", maxRepairAttempts: 0 },
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

			// status !== "completed" 让 CLI 以 exitCode 2 退出(main.ts),execFile 因此 reject ——
			// 与本文件 "reports the missing api key env var by name" 用例同一套处理方式,只是
			// 这里还要继续解析 stdout 里的 RunResult(CLI 在非 completed 时仍打印合法结果)。
			const error = (await run(
				process.execPath,
				[CLI, "run", "--spec", specPath, "--profile", profilePath, "--workdir", root, "--input", "hi"],
				{ timeout: EXEC_TIMEOUT_MS, env: { ...process.env, DFZQ_TEST_KEY: "sk-test-unused" } },
			).catch((e: unknown) => e)) as { code?: number; stdout?: string };

			expect(error.code).toBe(2);
			const lines = (error.stdout ?? "").trim().split("\n").filter(Boolean);
			const result = JSON.parse(lines.at(-1) as string);
			expect(result.status).toBe("error");
			expect(result.errorMessage).toContain("未找到 JSON");

			// maxRepairAttempts:0 生效:只有一次模型往返,没有为 C6 多发一次 reprompt。
			expect(mockServer.requests).toHaveLength(1);
		},
	);
});
