// biome-ignore-all lint/suspicious/noTemplateCurlyInString: expandEnvRefs 的被测语法就是字面量
// "${VAR}" —— 这条规则防的是「本想写模板字符串却漏了反引号」,在这里每一处命中都是误报。
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpToolset, expandEnvRefs } from "../src/toolsets/mcp/adapter.ts";
import { McpClient } from "../src/toolsets/mcp/client.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

/** POSIX 存活探测:kill(pid, 0) 不发信号,只检查进程是否还在(有权限访问)。与 mcp-client.test.ts 一致。 */
function isAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Task 6 重构后 ToolsetRegistry.resolve() 的句柄归属是"谁 resolve 谁负责 dispose"(不再有
// registry.disposeAll()),所以这里和 assembler.test.ts 一样用一个本地 cleanups 数组收集每次
// resolve() 拿到的 dispose,在 afterEach 里统一按 LIFO 顺序释放。
let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanups.reverse()) await dispose();
	cleanups = [];
});

async function resolve(registry: ToolsetRegistry, id: string) {
	const { tools, dispose } = await registry.resolve(id);
	cleanups.push(dispose);
	return tools;
}

function buildDemoRegistry(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register(
		"mcp-demo",
		createMcpToolset([{ id: "echo", command: process.execPath, args: [SERVER], env: {} }], null),
	);
	return registry;
}

describe("createMcpToolset", () => {
	it("exposes every MCP tool as a ToolDefinition", async () => {
		const tools = await resolve(buildDemoRegistry(), "mcp-demo");
		expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo", "leak"]);
		const echo = tools.find((t) => t.name === "echo");
		expect(echo?.description).toContain("Echo");
		expect(echo?.parameters).toMatchObject({ type: "object" });
	});

	it("executes a tool through the client", async () => {
		const tools = await resolve(buildDemoRegistry(), "mcp-demo");
		const echo = tools.find((t) => t.name === "echo");
		const result = await echo?.execute("call-1", { text: "round trip" } as never, undefined, undefined, {} as never);
		// AgentToolResult 没有顶层 output 字段(那是 wire 层 ToolResultMessage 的东西),文本走 content。
		expect(result?.content).toMatchObject([{ type: "text", text: "round trip" }]);
	});

	// fix round 1/5:execute() 必须 throw 才能让 pi 的 agent-loop(executePreparedToolCall 自己
	// catch,见 packages/agent/src/agent-loop.ts:665-702)生成 wire 层 isError:true 的结果 ——
	// 之前把 isError 塞进 details 完全到不了 ToolResultMessage.isError / tool_execution_end 事件 /
	// 各 provider 的 is_error 协议字段 / UI 着色,这些全部会读到假的 isError:false。
	// error.message 会被 createErrorToolResult 原样用作模型看到的文本,所以断言里既确认真的
	// reject,也确认 McpClient.callTool() 生成的可读错误信息("boom failed")被原样保留。
	it("throws on MCP tool failure so pi's agent-loop can mark the wire-level result as isError", async () => {
		const tools = await resolve(buildDemoRegistry(), "mcp-demo");
		const boom = tools.find((t) => t.name === "boom");
		await expect(boom?.execute("call-2", {} as never, undefined, undefined, {} as never)).rejects.toThrow(
			/boom failed/,
		);
	});

	it("prefixes tool names when two servers collide", async () => {
		const local = new ToolsetRegistry();
		local.register(
			"dup",
			createMcpToolset(
				[
					{ id: "a", command: process.execPath, args: [SERVER], env: {} },
					{ id: "b", command: process.execPath, args: [SERVER], env: {} },
				],
				null,
			),
		);
		const tools = await resolve(local, "dup");
		const names = tools.map((t) => t.name);
		expect(names).toContain("a__echo");
		expect(names).toContain("b__echo");
	});

	// fix round 1/5:审查指出之前的撞名用例两个 server 都用同一份 fixture TOOLS,是完全对称的
	// 撞名(echo/boom/leak 全撞)。Task 13 接的两个真实 blackbox-eval Python server 工具名完全不
	// 重叠,是"一个 server 有、另一个没有"的非对称场景 —— 现在补一个两者都有(echo/boom/leak 撞名
	// 加前缀)又各自独有一个工具(only-a/only-b 不撞名、不加前缀)的用例,覆盖前缀逻辑在同一对
	// server 里"部分撞名"的分支。
	it("prefixes only the colliding names when two servers partially overlap", async () => {
		const local = new ToolsetRegistry();
		local.register(
			"asymmetric",
			createMcpToolset(
				[
					{ id: "a", command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_EXTRA_TOOL: "only-a" } },
					{ id: "b", command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_EXTRA_TOOL: "only-b" } },
				],
				null,
			),
		);
		const names = (await resolve(local, "asymmetric")).map((t) => t.name);

		// 撞名(两个 server 都有 echo/boom/leak)—— 加前缀,原名不该出现。
		expect(names).toContain("a__echo");
		expect(names).toContain("b__echo");
		expect(names).not.toContain("echo");

		// 不撞名(each server 独有 only-a / only-b)—— 保持原名,不加前缀。
		expect(names).toContain("only-a");
		expect(names).toContain("only-b");
		expect(names).not.toContain("a__only-a");
		expect(names).not.toContain("b__only-b");
	});

	// fix round 1/5:代码走查已确认 spawn 失败路径正确(McpClient.spawn 自身 init 失败时会自己
	// dispose,所以 clients 数组只含已成功 spawn 的客户端),但缺一个专项测试。这里让第二个 server
	// 用 MCP_FIXTURE_FAIL_INIT_WITH_STDERR=1 让 initialize 失败,断言:①异常正常抛出(不是被吞掉
	// 或挂起),②第一个已经 spawn 成功的 client 被真正 dispose 掉(用 pid 存活探测,而不是只看
	// spy 被调用过 —— 要证明进程真的被回收,不是"dispose() 返回了但进程还活着"的假象)。
	it("disposes already-spawned clients when a later server fails to spawn", async () => {
		const spawnSpy = vi.spyOn(McpClient, "spawn");
		try {
			const registry = new ToolsetRegistry();
			registry.register(
				"broken",
				createMcpToolset(
					[
						{ id: "ok", command: process.execPath, args: [SERVER], env: {} },
						{
							id: "bad",
							command: process.execPath,
							args: [SERVER],
							env: { MCP_FIXTURE_FAIL_INIT_WITH_STDERR: "1" },
						},
					],
					null,
				),
			);

			await expect(registry.resolve("broken")).rejects.toThrow(/failed to initialize/);

			expect(spawnSpy).toHaveBeenCalledTimes(2);
			const firstClient = await spawnSpy.mock.results[0]?.value;
			expect(isAlive(firstClient?.pid)).toBe(false);
		} finally {
			spawnSpy.mockRestore();
		}
	});
});

describe("expandEnvRefs", () => {
	const base = { id: "policy-query", command: "x", args: ["-m", "query.mcp.server"], env: {} };

	it("expands ${VAR} in command, cwd and env values", () => {
		const out = expandEnvRefs(
			{ ...base, command: "${PY}", cwd: "${ROOT}", env: { PGHOST: "${DBHOST}" } },
			{ PY: "/venv/bin/python", ROOT: "/repo", DBHOST: "localhost" },
		);
		expect(out.command).toBe("/venv/bin/python");
		expect(out.cwd).toBe("/repo");
		expect(out.env).toEqual({ PGHOST: "localhost" });
	});

	it("leaves args untouched", () => {
		// args 是模块路径与开关,不该依赖环境:放开会让「这个 server 到底跑的是什么」不可读。
		const out = expandEnvRefs({ ...base, args: ["${PY}"] }, { PY: "/venv/bin/python" });
		expect(out.args).toEqual(["${PY}"]);
	});

	it("throws on an undefined variable instead of expanding to empty", () => {
		expect(() => expandEnvRefs({ ...base, command: "${MISSING}" }, {})).toThrow(/MISSING/);
	});

	it("throws on an empty-string variable", () => {
		// 空串展开会让 command 变成 "",spawn 报一个与病因无关的 ENOENT。
		expect(() => expandEnvRefs({ ...base, command: "${EMPTY}" }, { EMPTY: "" })).toThrow(/EMPTY/);
	});

	it("supports a literal path with no refs", () => {
		const out = expandEnvRefs({ ...base, command: "/usr/bin/python3" }, {});
		expect(out.command).toBe("/usr/bin/python3");
	});

	it("names the offending field so the error points at the spec, not at spawn", () => {
		expect(() => expandEnvRefs({ ...base, cwd: "${NOPE}" }, {})).toThrow(/"policy-query"\.cwd/);
	});
});

describe("per-run scope 注入(C10 下半段)", () => {
	const SCOPE = { runId: "r-1", permTags: ["P1"], corpusTypes: ["external"], options: {} };
	const server = {
		id: "echo",
		command: process.execPath,
		args: [SERVER],
		env: { MCP_FIXTURE_ECHO_ARGS: "1" },
	};

	function registryWith(scope: Parameters<typeof createMcpToolset>[1]): ToolsetRegistry {
		const registry = new ToolsetRegistry();
		registry.register("mcp-demo", createMcpToolset([server], scope));
		return registry;
	}

	async function callEcho(tools: Awaited<ReturnType<typeof resolve>>, params: Record<string, unknown>) {
		const echo = tools.find((t) => t.name === "echo-args");
		if (!echo) throw new Error("echo-args tool missing");
		const out = await echo.execute("c1", params as never, undefined, undefined, {} as never);
		// echo-args 回显收到的完整 arguments 对象本身。
		return JSON.parse((out.content[0] as { text: string }).text) as Record<string, unknown>;
	}

	it("merges scope into tools/call params as snake_case", async () => {
		const tools = await resolve(registryWith(SCOPE), "mcp-demo");
		const seen = await callEcho(tools, { text: "hi" });
		// C1 侧的契约是 snake_case。camelCase→snake_case 只在这一处转,别在 C1 再转一次。
		expect(seen.perm_tags).toEqual(["P1"]);
		expect(seen.corpus_types).toEqual(["external"]);
		expect(seen.run_id).toBe("r-1");
		expect(seen.text).toBe("hi");
	});

	it("does not let tool params override the injected scope", async () => {
		// 提权向量:模型即便猜到了字段名,也不能用工具参数盖掉授权位。
		// 注入必须在 spread 的**右侧**;写反了这条立刻红。
		const tools = await resolve(registryWith(SCOPE), "mcp-demo");
		const seen = await callEcho(tools, {
			text: "hi",
			perm_tags: ["ADMIN"],
			corpus_types: ["internal"],
			run_id: "r-evil",
		});
		expect(seen.perm_tags).toEqual(["P1"]);
		expect(seen.corpus_types).toEqual(["external"]);
		expect(seen.run_id).toBe("r-1");
	});

	it("refuses to spawn when the scope has no runId", async () => {
		// fail-closed 第 2 处(规格 §2.4):不完整的 scope 不该起子进程。
		const provider = createMcpToolset([server], { ...SCOPE, runId: "" });
		await expect(provider()).rejects.toThrow(/runId/i);
	});

	it("refuses to spawn when corpusTypes is empty", async () => {
		const provider = createMcpToolset([server], { ...SCOPE, corpusTypes: [] });
		await expect(provider()).rejects.toThrow(/corpusTypes/i);
	});

	it("re-checks the scope before every call, not just at spawn time", async () => {
		// fail-closed 第 3 处:scope 对象在 provider 调用之后被改空,下一次 call 必须拦。
		// 只有 spawn 期检查的话,这个向量完全打不到。
		const mutable = { ...SCOPE, corpusTypes: ["external"] };
		const tools = await resolve(registryWith(mutable), "mcp-demo");
		mutable.corpusTypes = [];
		const echo = tools.find((t) => t.name === "echo-args");
		await expect(echo?.execute("c1", { text: "hi" } as never, undefined, undefined, {} as never)).rejects.toThrow(
			/corpusTypes/i,
		);
	});

	// call 前复查必须覆盖**两种**缺失形态。既有那条只守 corpusTypes ——
	// 只守一种,另一种被改空时就会静默放行,而 runId 被改空的后果更重:
	// per-run 白名单退化成全局桶,池化(S3)后两个并发 run 能互取对方的条款详情。
	it("re-checks an emptied runId before every call, not just corpusTypes", async () => {
		const mutable = { ...SCOPE };
		const tools = await resolve(registryWith(mutable), "mcp-demo");
		mutable.runId = "";
		const echo = tools.find((t) => t.name === "echo-args");
		await expect(echo?.execute("c1", { text: "hi" } as never, undefined, undefined, {} as never)).rejects.toThrow(
			/runId/i,
		);
	});

	it("injects nothing when the scope is explicitly null", async () => {
		// eval / CLI 路径不是权限场景。**必须显式写 null** —— 类型上不可省略,
		// 于是生产路径漏传 scope 是编译错误,不会静默降级成「非权限场景」。
		const tools = await resolve(registryWith(null), "mcp-demo");
		const seen = await callEcho(tools, { text: "hi" });
		expect(seen).toEqual({ text: "hi" });
	});
});
