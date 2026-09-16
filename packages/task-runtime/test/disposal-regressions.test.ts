import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpToolset } from "../src/toolsets/mcp/adapter.ts";
import { McpClient } from "../src/toolsets/mcp/client.ts";

const server = {
	id: "echo",
	command: process.execPath,
	args: [fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url))],
	env: {},
};
afterEach(() => vi.restoreAllMocks());

it("cleans up a started client when tool metadata processing fails", async () => {
	const client = await McpClient.spawn(server);
	const close = client.dispose.bind(client);
	try {
		const disposed = vi.spyOn(client, "dispose");
		vi.spyOn(client, "listTools").mockImplementation(() => {
			throw new Error("invalid tool metadata");
		});
		vi.spyOn(McpClient, "spawn").mockResolvedValue(client);
		await expect(createMcpToolset([server], null)()).rejects.toThrow("invalid tool metadata");
		expect(disposed).toHaveBeenCalledTimes(1);
	} finally {
		await close();
	}
});

it("attempts every MCP disposal and shares the result across repeated callers", async () => {
	const a = await McpClient.spawn(server);
	const b = await McpClient.spawn(server);
	const closeA = a.dispose.bind(a),
		closeB = b.dispose.bind(b);
	try {
		const failed = vi.spyOn(b, "dispose").mockImplementation(async () => {
			await closeB();
			throw new Error("cleanup b");
		});
		const closed = vi.spyOn(a, "dispose");
		vi.spyOn(McpClient, "spawn").mockResolvedValueOnce(a).mockResolvedValueOnce(b);
		const handle = await createMcpToolset([server, { ...server, id: "second" }], null)();
		if (Array.isArray(handle) || !handle.dispose) throw new Error("expected disposable handle");
		const outcomes = await Promise.allSettled([handle.dispose(), handle.dispose()]);
		expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(failed).toHaveBeenCalledTimes(1);
	} finally {
		await closeA();
		await closeB();
	}
});

it("preserves the startup failure while attempting all earlier clients' cleanup", async () => {
	const a = await McpClient.spawn(server);
	const b = await McpClient.spawn(server);
	const closeA = a.dispose.bind(a),
		closeB = b.dispose.bind(b);
	try {
		vi.spyOn(a, "dispose").mockImplementation(async () => {
			await closeA();
			throw new Error("cleanup a");
		});
		const closed = vi.spyOn(b, "dispose");
		vi.spyOn(McpClient, "spawn")
			.mockResolvedValueOnce(a)
			.mockResolvedValueOnce(b)
			.mockRejectedValueOnce(new Error("startup c"));
		const error = await createMcpToolset([server, { ...server, id: "b" }, { ...server, id: "c" }], null)().catch(
			(e: unknown) => e,
		);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(AggregateError);
		if (error instanceof AggregateError) expect(error.errors[0].message).toBe("startup c");
	} finally {
		await closeA();
		await closeB();
	}
});
