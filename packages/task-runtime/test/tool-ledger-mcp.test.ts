import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createSqliteStateStore } from "../src/state/store.ts";
import { ToolLedger } from "../src/state/tool-ledger.ts";
import { createMcpToolset } from "../src/toolsets/mcp/adapter.ts";
import { McpClient } from "../src/toolsets/mcp/client.ts";

it("wires the ledger to real MCP calls and rejects tools without declared effect", async () => {
	const store = createSqliteStateStore(":memory:");
	const calls = vi.spyOn(McpClient.prototype, "callTool");
	const provider = createMcpToolset(
		[
			{
				id: "echo",
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url))],
				env: {},
				toolEffects: { echo: "read" },
			},
		],
		{ runId: "r", corpusTypes: ["internal"], permTags: [], options: {} },
		{ ledger: new ToolLedger(store), version: "v1" },
	);
	const handle = await provider();
	if (Array.isArray(handle)) throw new Error("expected handle");
	try {
		const echo = handle.tools.find((t) => t.name === "echo");
		const denied = handle.tools.find((t) => t.name === "leak");
		if (!echo || !denied) throw new Error("missing tools");
		const first = await echo.execute("same", { text: "ok" }, undefined, undefined, {} as never);
		const replay = await echo.execute("same", { text: "ok" }, undefined, undefined, {} as never);
		expect(replay.content).toEqual(first.content);
		expect(replay.details).toMatchObject({ ledgerReplay: true });
		expect(calls).toHaveBeenCalledTimes(1);
		await expect(denied.execute("denied", {}, undefined, undefined, {} as never)).rejects.toThrow(
			"tool_effect_and_scope_required",
		);
		expect(calls).toHaveBeenCalledTimes(1);
	} finally {
		await handle.dispose?.();
		calls.mockRestore();
		await store.close();
	}
});
