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
	/**
	 * 单次 MCP 请求的硬超时。默认由 McpClient 采用 30s；检索/模型类工具可在 spec 中
	 * 显式放宽，避免首次加载模型时被通用超时误杀。
	 */
	requestTimeoutMs?: number;
}

/** 多 server 同名工具时的前缀分隔符。 */
const NAME_SEPARATOR = "__";

/**
 * 一个 run 的授权范围。由 `createDefaultRuntimeFactory` 从 `POST /runs` 的 `filters` 组装,
 * **agent 不可见** —— 这三项不出现在任何工具的 `inputSchema` 里(工具 schema 直接取自 MCP
 * server 的声明,见 `toToolDefinition`),模型既看不见也填不了。
 */
export interface McpRunScope {
	runId: string;
	permTags: string[];
	corpusTypes: string[];
	options: Record<string, unknown>;
}

/** camelCase → snake_case。**只在这一处转**,C1 侧按 snake_case 收,不再转第二次。 */
function scopeParams(scope: McpRunScope): Record<string, unknown> {
	return { perm_tags: scope.permTags, corpus_types: scope.corpusTypes, run_id: scope.runId };
}

function assertScope(scope: McpRunScope): void {
	if (!scope.runId) {
		throw new Error("MCP toolset scope is missing runId; refusing to serve without a run boundary");
	}
	if (!Array.isArray(scope.corpusTypes) || scope.corpusTypes.length === 0) {
		throw new Error("MCP toolset scope has empty corpusTypes; refusing to serve without an authorization scope");
	}
}

/**
 * `get_clause_detail` 的正文已经由受信 MCP 返回；把通过最小形状校验的正文放进工具私有 details，
 * 供运行时在最终响应中复用。details 不会进入模型上下文，避免正文因展示需求重复占用 prompt。
 */
function sourceDetails(text: string): Array<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(text) as { items?: unknown };
		if (!Array.isArray(parsed.items)) return [];
		return parsed.items.filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as { clause_id?: unknown }).clause_id === "string" &&
				typeof (item as { text?: unknown }).text === "string" &&
				(item as { text: string }).text.trim().length > 0,
		);
	} catch {
		return [];
	}
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandValue(raw: string, env: NodeJS.ProcessEnv, where: string): string {
	return raw.replace(ENV_REF, (_match, name: string) => {
		const value = env[name];
		// 未定义与空串都要抛:空串展开后 command 变成 ""、cwd 变成进程 cwd,spawn 报出来的是
		// 一个与病因无关的 ENOENT。装配期失败要响要早,别让它伪装成运行期的找不到文件。
		if (value === undefined || value === "") {
			const why = value === undefined ? "not set" : "empty";
			throw new Error(`MCP server spec ${where}: environment variable "${name}" is ${why}`);
		}
		return value;
	});
}

/**
 * 展开 `command` / `cwd` / `env` 值里的 `${VAR}`。
 *
 * 为什么需要:MCP server 可能住在另一个仓(C1 在 dfzq-audit-ai),它的解释器与仓库路径
 * 逐机器不同,而 spec 文件是进版本库的。
 *
 * **`args` 刻意不展开** —— 那里放的是模块路径与开关,让它依赖环境会使「这个 server 到底
 * 跑的是什么」不可读。
 *
 * 与 `path-guard` 的 `<runId>` 是两套语法,**不要合并**:`<x>` 是 per-run 值、每次调用求值;
 * `${X}` 是进程级环境变量、装配期求值。展开时机与失败语义都不同。
 */
export function expandEnvRefs(spec: McpServerSpec, env: NodeJS.ProcessEnv): McpServerSpec {
	const expanded: McpServerSpec = {
		...spec,
		command: expandValue(spec.command, env, `"${spec.id}".command`),
		env: Object.fromEntries(
			Object.entries(spec.env).map(([key, value]) => [key, expandValue(value, env, `"${spec.id}".env.${key}`)]),
		),
	};
	if (spec.cwd !== undefined) expanded.cwd = expandValue(spec.cwd, env, `"${spec.id}".cwd`);
	return expanded;
}

/**
 * 把一组 MCP server 装成一个 `ToolsetProvider`:每次 resolve() 都会重新 spawn 所有 server、
 * 把它们的工具合并成一份 `ToolDefinition[]`,并返回一个统一的 `dispose()` 收尾所有子进程。
 * 若中途某个 server 起不来,已经 spawn 成功的必须先被 dispose 掉再把错误抛出去 —— 不留孤儿进程。
 */
export function createMcpToolset(servers: McpServerSpec[], scope: McpRunScope | null): ToolsetProvider {
	return async (): Promise<ToolsetHandle> => {
		// fail-closed 第 2 处(规格 §2.4):scope 不完整就不该起子进程。
		// scope 为 null 是**显式声明**「这不是权限场景」(eval / CLI 路径);参数不可省略,
		// 于是生产路径漏传是编译错误,不会静默降级成非权限场景。
		if (scope) assertScope(scope);
		// 展开在 spawn 之前、且在 try 之外:变量缺失是配置错,该在没起任何子进程时就抛。
		const resolved = servers.map((server) => expandEnvRefs(server, process.env));
		const clients: McpClient[] = [];
		try {
			for (const server of resolved) {
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
			const serverId = resolved[index].id;
			for (const info of client.listTools()) {
				const exposedName =
					(counts.get(info.name) ?? 0) > 1 ? `${serverId}${NAME_SEPARATOR}${info.name}` : info.name;
				tools.push(toToolDefinition(client, info, exposedName, scope));
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

function toToolDefinition(
	client: McpClient,
	info: McpToolInfo,
	exposedName: string,
	scope: McpRunScope | null,
): ToolDefinition {
	return {
		name: exposedName,
		label: info.name,
		description: info.description ?? info.name,
		// MCP 的 inputSchema 已是 JSON Schema,Type.Unsafe 零转换包住即可,不需要 schema 转换器。
		parameters: Type.Unsafe(info.inputSchema),
		execute: async (_toolCallId: string, params: unknown, signal: AbortSignal | undefined) => {
			// fail-closed 第 3 处(规格 §2.4):每次 call 前复查。只有 spawn 期检查的话,
			// scope 对象在 spawn 之后被改空这个向量完全打不到。
			if (scope) assertScope(scope);
			// 注入在 spread 的**右侧** —— 工具参数不得覆盖授权位。写反了模型就能提权:
			// 它即便猜到字段名也盖不掉。scope 为 null 时不注入(非权限场景)。
			const merged = {
				...((params ?? {}) as Record<string, unknown>),
				...(scope ? scopeParams(scope) : {}),
			};
			const result = await client.callTool(info.name, merged, signal);
			if (result.isError) {
				// throw 是向 pi 表达"这次工具调用失败了"的唯一方式:agent-loop 的 executePreparedToolCall
				// 自己 catch 异常并生成 wire 层 isError:true 的结果(不会中断 batch/循环,见
				// packages/agent/src/agent-loop.ts:665-702 的 try/catch + createErrorToolResult),
				// 而 AgentToolResult 返回值本身没有 isError 字段可写,写在 details 里下游各处
				// (ToolResultMessage.isError、tool_execution_end 事件、UI 着色、各 provider 的
				// is_error 协议字段)都读不到。error.message 会被 createErrorToolResult 原样用作
				// 模型看到的文本,所以保留 McpClient.callTool() 生成的可读错误信息
				// (形如 `MCP tool "x" failed: ...`),不再重新包装。
				throw new Error(result.text);
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: info.name === "get_clause_detail" ? { source_details: sourceDetails(result.text) } : undefined,
			};
		},
	};
}
