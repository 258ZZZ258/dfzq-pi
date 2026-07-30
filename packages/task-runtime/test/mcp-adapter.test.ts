import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpToolset } from "../src/toolsets/mcp/adapter.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

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
		// AgentToolResult 没有顶层 output/isError 字段(那是 wire 层 ToolResultMessage 的东西,
		// 由 agent-loop 从 execute() 是否 throw 派生)——文本走 content,isError 语义走 details。
		expect(result?.content).toMatchObject([{ type: "text", text: "round trip" }]);
		expect(result?.details).toMatchObject({ isError: false });
	});

	it("surfaces MCP failures as isError, not thrown", async () => {
		const tools = await resolve(buildDemoRegistry(), "mcp-demo");
		const boom = tools.find((t) => t.name === "boom");
		const result = await boom?.execute("call-2", {} as never, undefined, undefined, {} as never);
		expect(result?.details).toMatchObject({ isError: true });
		expect(result?.content).toMatchObject([{ type: "text", text: expect.stringContaining("boom failed") }]);
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
});
