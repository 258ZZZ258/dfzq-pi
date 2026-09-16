import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, type McpSpawnOptions } from "../src/toolsets/mcp/client.ts";

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

const clients: McpClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.dispose();
});

type SpawnExtra = Partial<Omit<McpSpawnOptions, "id" | "command" | "args" | "env">>;

async function spawn(extra?: SpawnExtra): Promise<McpClient> {
	const client = await McpClient.spawn({
		id: "echo",
		command: process.execPath,
		args: [SERVER],
		env: {},
		...extra,
	});
	clients.push(client);
	return client;
}

function abortListenerCount(signal: AbortSignal): number {
	return getEventListeners(signal, "abort").length;
}

describe("McpClient abort signal lifecycle", () => {
	it("honors a signal that was already aborted before callTool()", async () => {
		const client = await spawn();
		const controller = new AbortController();
		controller.abort();

		const result = await client.callTool("echo", { text: "must not be sent" }, controller.signal);

		expect(result.isError).toBe(true);
		expect(result.text).toContain("aborted");
		expect(result.text).not.toContain("must not be sent");
		expect(abortListenerCount(controller.signal)).toBe(0);
	});

	it("removes abort listeners after successful calls settle", async () => {
		const client = await spawn();
		const controller = new AbortController();

		for (let i = 0; i < 5; i++) {
			const result = await client.callTool("echo", { text: `ok-${i}` }, controller.signal);
			expect(result).toEqual({ text: `ok-${i}`, isError: false });
			expect(abortListenerCount(controller.signal)).toBe(0);
		}
	});
});
