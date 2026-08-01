import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/toolsets/mcp/client.ts";

/**
 * 跨仓握手:本仓的 MCP client(C2)↔ dfzq-audit-ai 的 policy-query-mcp(C1)。
 *
 * **这是唯一验证「C2 硬编码的 protocolVersion 与 C1 的 mcp SDK 对得上」的地方**(规格 §6-3)。
 * C2 用 `"2024-11-05"`(client.ts),而它正是 C1 那个 SDK 的 `OLDEST_SUPPORTED_VERSION` ——
 * 今天握得上,但没有余量。SDK 下一个大版本若把它移出握手集合,启动即失败,而两侧各自的
 * 单元测试都不会红。
 *
 * 需要四个 env(缺任一即 skip):
 *   DFZQ_AUDIT_AI_PYTHON   fork 的解释器
 *   DFZQ_AUDIT_AI_ROOT     fork 仓根
 *   PIPELINE_CONFIG_DIR    指向改过 model_name 的 config 副本(规格 §0.3)
 *   POLICY_MCP_AUDIT_LOG   A6 对账落点;C1 未配置即 fail-closed 启动失败(server.py
 *                          require_audit_log_path())——所以这里必须真带上,不能只是
 *                          为了让本测试跑起来而放宽
 *
 * ⚠ **skip 不等于通过。** CI 上没有 dfzq-audit-ai 所以跳过,但本地必须真跑过 ——
 * 出口判据里单列了这一条。
 */
const PY = process.env.DFZQ_AUDIT_AI_PYTHON;
const ROOT = process.env.DFZQ_AUDIT_AI_ROOT;
const AUDIT = process.env.POLICY_MCP_AUDIT_LOG;
const available = Boolean(PY && ROOT && AUDIT && existsSync(PY) && existsSync(ROOT));

function spawnC1(): Promise<McpClient> {
	return McpClient.spawn({
		id: "policy-query",
		command: PY as string,
		args: ["-m", "query.mcp.server"],
		// McpClient 不继承 process.env(白名单 env,见 client.ts),这四项要显式带上。
		env: {
			PIPELINE_CONFIG_DIR: process.env.PIPELINE_CONFIG_DIR ?? "",
			POLICY_MCP_AUDIT_LOG: process.env.POLICY_MCP_AUDIT_LOG ?? "",
			HF_HUB_OFFLINE: "1",
			PATH: process.env.PATH ?? "",
		},
		cwd: ROOT as string,
	});
}

describe.skipIf(!available)("跨仓握手:C2 ↔ C1(policy-query-mcp)", () => {
	it("completes the initialize handshake and lists the policy-query tools", async () => {
		const client = await spawnC1();
		try {
			expect(client.listTools().map((t) => t.name)).toContain("search_policy");
		} finally {
			await client.dispose();
		}
	}, 60000);

	it("exposes no authorization-layer parameter in any tool schema", async () => {
		// 规格 §2.3:授权层对 agent 不可见是**结构性**的 —— 工具 schema 直接取自 C1 的声明,
		// 注入发生在 schema 之外。这条在跨仓层面再验一次:C1 侧的单测只看得见自己那份 TOOL。
		const client = await spawnC1();
		try {
			for (const tool of client.listTools()) {
				const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
				expect(props).not.toContain("perm_tags");
				expect(props).not.toContain("corpus_types");
				expect(props).not.toContain("run_id");
			}
		} finally {
			await client.dispose();
		}
	}, 60000);

	it("fail-closes a call with no authorization scope, without leaking clause text", async () => {
		// fail-closed 第 4 处(规格 §2.4):C1 侧不假定上游一定校验过。
		const client = await spawnC1();
		try {
			const result = await client.callTool("search_policy", { query: "合规检查" });
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/missing authorization scope/);
			// 规格 §6-1:业务级错误响应不得携带可引用的条款正文。
			// 带正文 ⇒ 模型引用 ⇒ 该 id 因 isError 过滤不在 clauseIds 里 ⇒ 反幻觉校验把
			// 一次真实检索到的答案判成幻觉。
			expect(result.text).not.toMatch(/第[一二三四五六七八九十百]+条/);
		} finally {
			await client.dispose();
		}
	}, 60000);

	it("rejects audit_project with a code distinct from missing scope", async () => {
		const client = await spawnC1();
		try {
			const result = await client.callTool("search_policy", {
				query: "合规检查",
				perm_tags: [],
				corpus_types: ["external", "audit_project"],
				run_id: "r-1",
			});
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/not yet supported/);
			expect(result.text).not.toMatch(/missing authorization scope/);
		} finally {
			await client.dispose();
		}
	}, 60000);
});
