import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpToolset } from "../src/toolsets/mcp/adapter.ts";
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
		createMcpToolset([{ id: "echo", command: process.execPath, args: [SERVER], env: {} }]),
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
			createMcpToolset([
				{ id: "a", command: process.execPath, args: [SERVER], env: {} },
				{ id: "b", command: process.execPath, args: [SERVER], env: {} },
			]),
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
			createMcpToolset([
				{ id: "a", command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_EXTRA_TOOL: "only-a" } },
				{ id: "b", command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_EXTRA_TOOL: "only-b" } },
			]),
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
				createMcpToolset([
					{ id: "ok", command: process.execPath, args: [SERVER], env: {} },
					{
						id: "bad",
						command: process.execPath,
						args: [SERVER],
						env: { MCP_FIXTURE_FAIL_INIT_WITH_STDERR: "1" },
					},
				]),
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
