import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolsetHandle, ToolsetProvider } from "../registry.ts";
import { McpClient, type McpToolInfo } from "./client.ts";

export interface McpServerSpec {
	id: string;
	command: string;
	args: string[];
	/** 白名单 env(安全方案 L1(a))。eval 模式下在此注入 EVAL_TASK_LOG。 */
	env: Record<string, string>;
	cwd?: string;
}

/**
 * `execute()` 的 `details` 里携带的结构化信息。`AgentToolResult` 本身没有 `isError` 字段
 * (那是 wire 层 `ToolResultMessage.isError`,由 agent-loop 根据 execute() 是否 throw 派生,
 * 不是 execute() 返回值的一部分)——`details` 是这个类型上唯一的自由扩展点,所以 MCP 的
 * isError 语义放在这里:沿用 `McpClient.callTool()` 的"映射不抛"约定(见 client.ts),把
 * 判断权交给调用方(模型可以从错误结果里换个工具或参数继续,而不是让整个 tool batch 因为
 * 一次 MCP 调用失败而被打断)。
 */
export interface McpToolResultDetails {
	isError: boolean;
}

/** 多 server 同名工具时的前缀分隔符。 */
const NAME_SEPARATOR = "__";

/**
 * 把一组 MCP server 装成一个 `ToolsetProvider`:每次 resolve() 都会重新 spawn 所有 server、
 * 把它们的工具合并成一份 `ToolDefinition[]`,并返回一个统一的 `dispose()` 收尾所有子进程。
 * 若中途某个 server 起不来,已经 spawn 成功的必须先被 dispose 掉再把错误抛出去 —— 不留孤儿进程。
 */
export function createMcpToolset(servers: McpServerSpec[]): ToolsetProvider {
	return async (): Promise<ToolsetHandle> => {
		const clients: McpClient[] = [];
		try {
			for (const server of servers) {
				clients.push(await McpClient.spawn(server));
			}
		} catch (error) {
			for (const client of clients) await client.dispose();
			throw error;
		}

		// 同名工具计数:只有真的撞名的工具才加前缀,单一 server 提供的工具保持原名,
		// 对模型更好用(工具名越短、语义越直接,选择正确工具的准确率越高)。
		const counts = new Map<string, number>();
		for (const client of clients) {
			for (const tool of client.listTools()) {
				counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
			}
		}

		const tools: ToolDefinition[] = [];
		clients.forEach((client, index) => {
			const serverId = servers[index].id;
			for (const info of client.listTools()) {
				const exposedName =
					(counts.get(info.name) ?? 0) > 1 ? `${serverId}${NAME_SEPARATOR}${info.name}` : info.name;
				tools.push(toToolDefinition(client, info, exposedName));
			}
		});

		return {
			tools,
			dispose: async () => {
				for (const client of clients.reverse()) await client.dispose();
			},
		};
	};
}

function toToolDefinition(client: McpClient, info: McpToolInfo, exposedName: string): ToolDefinition {
	return {
		name: exposedName,
		label: info.name,
		description: info.description ?? info.name,
		// MCP 的 inputSchema 已是 JSON Schema,Type.Unsafe 零转换包住即可,不需要 schema 转换器。
		parameters: Type.Unsafe(info.inputSchema),
		execute: async (_toolCallId: string, params: unknown, signal: AbortSignal | undefined) => {
			const result = await client.callTool(info.name, (params ?? {}) as Record<string, unknown>, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: { isError: result.isError },
			};
		},
	};
}
