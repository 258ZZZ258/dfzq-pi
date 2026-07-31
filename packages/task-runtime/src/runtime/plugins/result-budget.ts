import type { ExtensionAPI, ToolResultEvent as PiToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { PluginDescriptor } from "../plugin-registry.ts";

export const RESULT_BUDGET_PLUGIN_NAME = "result-budget";

export interface ResultBudgetOptions {
	maxHits?: Record<string, number>;
	maxChars?: Record<string, number> & { default?: number };
}

/** 结果对象里放数组的字段名不统一 —— 逐个试,第一个命中的就是命中列表。 */
const HIT_KEYS = ["hits", "cases", "items", "rows"] as const;

function tryParseObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * pi 真实的 `tool_result` 事件把 content 定成 `(TextContent | ImageContent)[]`——
 * `@earendil-works/pi-coding-agent` 的 core/agent-session.js 里 `afterToolCall` 钩子
 * `content: result.content` 直接透传 `AgentToolResult.content`,而 task-runtime 自己的
 * MCP 适配层(toolsets/mcp/adapter.ts)产出的 `AgentToolResult` 固定是单元素
 * `[{ type: "text", text }]`。生产路径上 content **必是数组**,从来不是字符串。
 *
 * 但本文件的单测(result-budget.test.ts)把 content 当一段纯文本 / JSON 字符串直接喂给
 * handler —— 这是经由 `unknown` 类型的假 `on()` 绕开静态类型检查后,单测自行选择的一种
 * 更容易断言的输入形态,现实依据与 final-judge.ts 里 collectClauseIds 的注释同一个前提:
 * "MCP 工具结果常见形态是 content[].text 里塞一段 JSON 字符串"。
 *
 * 这里必须对两种输入形态都接得住:静态类型上 content 只可能是数组,但运行时单测确确实实
 * 会喂一个字符串进来。少了字符串分支不是"类型上不严谨",是会让这条 catch 分支在真实工具
 * 结果(数组)之外的任何字符串输入上抛 TypeError——而 pi 的 ExtensionRunner.emitToolResult
 * 会 catch 住这个异常、把它当成"这个 handler 这次没返回结果"处理(见该文件对
 * `tool_result` handler 的 try/catch),截断判断因此**整体静默失效**,是比"漏回填一个
 * 字段"更严重的一种静默失效。
 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/** 按 content 原本的形状封回去:字符串进字符串出,数组进单文本块数组出。 */
function rewrapContent(original: unknown, text: string): PiToolResultEvent["content"] {
	// 见上面 extractText 的注释:这个类型断言只在"原本就是数组"(生产路径,静态类型
	// 唯一允许的形态)时如实描述返回值;字符串分支只喂给单测里那个绕开了类型检查的假
	// on(),对真实 pi 运行时不可达。
	return (typeof original === "string" ? text : [{ type: "text", text }]) as PiToolResultEvent["content"];
}

export const resultBudgetDescriptor: PluginDescriptor = {
	name: RESULT_BUDGET_PLUGIN_NAME,
	hooks: ["tool_result"], // 替换型:同一 hook 只允许一个插件认领
	factory: (_ctx, rawOptions?: Record<string, unknown>) => {
		const options = (rawOptions ?? {}) as ResultBudgetOptions;
		const maxHits = options.maxHits ?? {};
		const maxChars = options.maxChars ?? {};
		return {
			name: RESULT_BUDGET_PLUGIN_NAME,
			factory: (pi: ExtensionAPI) => {
				pi.on("tool_result", async (event) => {
					const toolName = event.toolName;
					let content = extractText(event.content);

					const parsed = tryParseObject(content);
					const limit = maxHits[toolName];
					if (parsed && limit !== undefined) {
						for (const key of HIT_KEYS) {
							const array = parsed[key];
							if (!Array.isArray(array) || array.length <= limit) continue;
							const total = typeof parsed.total === "number" ? parsed.total : array.length;
							parsed[key] = array.slice(0, limit);
							parsed._truncated = {
								total,
								shown: limit,
								hint: "结果已截断,请缩小检索范围或分批查询",
							};
							content = JSON.stringify(parsed);
							break;
						}
					}

					const cap = maxChars[toolName] ?? maxChars.default;
					if (cap !== undefined && content.length > cap) {
						content = `${content.slice(0, cap)}\n…[已截断,原长 ${content.length} 字符]`;
					}

					// ⚠ details / isError / usage 必须原样带回。这不是在赌 pi 的合并策略——
					// 实测 @earendil-works/pi-coding-agent 的 ExtensionRunner.emitToolResult
					// (core/extensions/runner.js:639-670)对这三个字段是逐个"undefined 就不
					// 覆盖、保留原值"的条件合并,并非无差别清空;但这是未文档化的实现细节,
					// 不是公开契约,升级 pi 时可能改变。本文件的单测直接读 handler 的返回值、
					// 不做任何合并(见 result-budget.test.ts),按那个更严格的口径:漏回填就是
					// 返回 undefined,在这里(以及任何不依赖 pi 具体合并实现的调用方眼里)都
					// 等价于把它清空。三个字段都原样带回,不依赖上游这个未承诺的兜底。
					return {
						content: rewrapContent(event.content, content),
						details: event.details,
						isError: event.isError,
						usage: event.usage,
					};
				});
			},
		};
	},
};
