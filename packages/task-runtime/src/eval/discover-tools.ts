import type { McpServerSpec } from "../toolsets/mcp/adapter.ts";
import { McpClient } from "../toolsets/mcp/client.ts";

/**
 * 跑 initialize + tools/list 拿真实工具名。
 *
 * ⚠ 不得用正则从 Python 源码猜工具名 —— fixture 里 `"name": "policy_query_mcp"` 是
 * **server 名**,正则会把它误当工具名混进 tools 白名单,而白名单里的假名字不会报错,
 * 只会让真工具少激活一个(`sdk.ts` 按名字取交集)。
 */
export async function discoverTools(servers: McpServerSpec[]): Promise<Array<{ serverId: string; tools: string[] }>> {
	const out: Array<{ serverId: string; tools: string[] }> = [];
	for (const server of servers) {
		const client = await McpClient.spawn(server);
		try {
			out.push({ serverId: server.id, tools: client.listTools().map((tool) => tool.name) });
		} finally {
			await client.dispose();
		}
	}
	return out;
}
