import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { localAuditEnvironment, localAuditServers } from "../src/server/local-services.ts";
import { McpClient } from "../src/toolsets/mcp/client.ts";

it("resolves audit-ai inside this repository without an external checkout", () => {
	const env = localAuditEnvironment({});
	expect(env.DFZQ_AUDIT_AI_ROOT).toBe(
		fileURLToPath(new URL("../../../services/audit-ai/", import.meta.url)).replace(/\/$/, ""),
	);
	expect(existsSync(join(env.DFZQ_AUDIT_AI_ROOT!, "service.py"))).toBe(true);
});

const python = process.env.DFZQ_AUDIT_AI_PYTHON ?? localAuditEnvironment({}).DFZQ_AUDIT_AI_PYTHON!;
it.skipIf(!existsSync(python))(
	"handshakes with the embedded Python service and rejects unsupported scopes before backend access",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "embedded-mcp-"));
		const servers = localAuditServers(
			[
				{
					id: "policy-query",
					command: ["$", "{", "DFZQ_AUDIT_AI_PYTHON", "}"].join(""),
					args: ["-m", "query.mcp.server"],
					cwd: ["$", "{", "DFZQ_AUDIT_AI_ROOT", "}"].join(""),
					env: {
						POLICY_MCP_AUDIT_LOG: ["$", "{", "POLICY_MCP_AUDIT_LOG", "}"].join(""),
						HF_HUB_OFFLINE: "1",
						PATH: process.env.PATH ?? "",
					},
				},
			],
			{
				DFZQ_AUDIT_AI_PYTHON: python,
				POLICY_MCP_AUDIT_LOG: join(dir, "audit.jsonl"),
				AUDIT_AI_TENANT_ID: "t1",
				PIPELINE_DB_DSN: "postgresql://must-not-connect",
			},
		);
		const client = await McpClient.spawn(servers[0]);
		try {
			expect(client.listTools().map((tool) => tool.name)).toContain("search_policy");
			const denied = await client.callTool("search_policy", {
				query: "q",
				tenant_id: "other",
				user_id: "u",
				perm_tags: ["d"],
				corpus_types: ["internal"],
				run_id: "r",
			});
			expect(denied.isError).toBe(true);
			expect(denied.text).toContain("tenant");
			const unsupported = await client.callTool("search_policy", {
				query: "q",
				tenant_id: "t1",
				user_id: "u",
				project_id: "restricted",
				perm_tags: ["d"],
				corpus_types: ["internal"],
				run_id: "r",
			});
			expect(unsupported.isError).toBe(true);
			expect(unsupported.text).toContain("unsupported authorization restriction");
			for (const tool of client.listTools())
				expect(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})).not.toContain(
					"tenant_id",
				);
		} finally {
			await client.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	},
	20000,
);
