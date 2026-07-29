import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/toolsets/mcp/client.ts";

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

const clients: McpClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.dispose();
});

async function spawn(env?: Record<string, string>) {
	const client = await McpClient.spawn({
		id: "echo",
		command: process.execPath,
		args: [SERVER],
		env: env ?? {},
	});
	clients.push(client);
	return client;
}

describe("McpClient", () => {
	it("initializes and lists tools", async () => {
		const client = await spawn();
		const names = client
			.listTools()
			.map((t) => t.name)
			.sort();
		expect(names).toEqual(["boom", "echo", "leak"]);
		expect(client.listTools().find((t) => t.name === "echo")?.inputSchema).toMatchObject({ type: "object" });
	});

	it("calls a tool and returns text content", async () => {
		const client = await spawn();
		const result = await client.callTool("echo", { text: "hi there" });
		expect(result.isError).toBe(false);
		expect(result.text).toBe("hi there");
	});

	it("maps a JSON-RPC error to isError instead of throwing", async () => {
		const client = await spawn();
		const result = await client.callTool("boom", {});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("boom failed");
	});

	it("passes only whitelisted env to the child process", async () => {
		process.env.DFZQ_SECRET_PROBE = "must-not-leak";
		const client = await spawn({ ALLOWED_VALUE: "ok" });
		const result = await client.callTool("leak", {});
		const env = JSON.parse(result.text) as Record<string, string>;
		expect(env.ALLOWED_VALUE).toBe("ok");
		expect(env.DFZQ_SECRET_PROBE).toBeUndefined();
		delete process.env.DFZQ_SECRET_PROBE;
	});

	it("rejects calls after dispose", async () => {
		const client = await spawn();
		await client.dispose();
		clients.length = 0;
		await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/disposed/i);
	});
});
