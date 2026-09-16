import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createMcpToolset } from "../src/toolsets/mcp/adapter.ts";

it("injects trusted tenant/project identity and checks asynchronous authorization before MCP dispatch", async () => {
	let revoked = false;
	const provider = createMcpToolset(
		[
			{
				id: "echo",
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url))],
				env: { MCP_FIXTURE_ECHO_ARGS: "1" },
			},
		],
		{
			runId: "r",
			tenantId: "tenant",
			userId: "user",
			projectId: "p",
			owner: "o",
			permTags: ["allowed"],
			corpusTypes: ["internal"],
			options: {},
		},
		undefined,
		async () => {
			if (revoked) throw new Error("authorization_revoked");
		},
	);
	const handle = await provider();
	if (Array.isArray(handle)) throw new Error("expected handle");
	try {
		const tool = handle.tools.find((t) => t.name === "echo-args")!;
		const result = await tool.execute(
			"c",
			{
				tenant_id: "forged",
				user_id: "forged",
				project_id: "forged",
				owner: "forged",
				perm_tags: ["admin"],
				include_superseded: true,
			},
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.find((c) => c.type === "text");
		if (text?.type !== "text") throw new Error("no result");
		expect(JSON.parse(text.text)).toMatchObject({
			tenant_id: "tenant",
			user_id: "user",
			project_id: "p",
			owner: "o",
			perm_tags: ["allowed"],
			include_superseded: false,
		});
		revoked = true;
		await expect(tool.execute("next", {}, undefined, undefined, {} as never)).rejects.toThrow(
			"authorization_revoked",
		);
	} finally {
		await handle.dispose?.();
	}
});
