import { describe, expect, it } from "vitest";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { resultBudgetDescriptor } from "../src/runtime/plugins/result-budget.ts";

function makeContext(): PluginContext {
	return {
		getRunId: () => "r1",
		getRunInput: () => "",
		callTool: async () => ({}),
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: () => {},
	};
}

function instantiate(options: Record<string, unknown>) {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	const extension = resultBudgetDescriptor.factory(makeContext(), options);
	const factory = typeof extension === "function" ? extension : extension.factory;
	(factory as (api: unknown) => void)({
		on: (_type: string, h: (event: unknown) => Promise<unknown>) => {
			handler = h;
		},
	});
	return handler!;
}

const OPTIONS = {
	maxHits: { search_policy: 2 },
	maxChars: { get_clause_detail: 20, default: 40 },
};

describe("result-budget", () => {
	it("claims the replacing tool_result hook", () => {
		expect(resultBudgetDescriptor.hooks).toEqual(["tool_result"]);
	});

	it("is registered in the default plugin registry", () => {
		expect(createDefaultPluginRegistry().has("result-budget")).toBe(true);
	});

	it("trims an over-long hit array and records the truncation", async () => {
		const handler = instantiate({ maxHits: { search_policy: 2 }, maxChars: { default: 10_000 } });
		const content = JSON.stringify({ total: 5, hits: [1, 2, 3, 4, 5] });
		const out = (await handler({
			toolName: "search_policy",
			content,
			details: { d: 1 },
			isError: false,
			usage: { u: 1 },
		})) as {
			content: string;
		};
		const parsed = JSON.parse(out.content) as { hits: number[]; _truncated: { total: number; shown: number } };
		expect(parsed.hits).toEqual([1, 2]);
		expect(parsed._truncated).toMatchObject({ total: 5, shown: 2 });
	});

	it("leaves a short result untouched", async () => {
		const handler = instantiate({ maxHits: { search_policy: 2 }, maxChars: { default: 10_000 } });
		const content = JSON.stringify({ total: 1, hits: [1] });
		const out = (await handler({ toolName: "search_policy", content, isError: false })) as { content: string };
		expect(JSON.parse(out.content)).toEqual({ total: 1, hits: [1] });
	});

	it("caps the character length per tool and falls back to default", async () => {
		const handler = instantiate(OPTIONS);
		const long = "x".repeat(200);
		const detail = (await handler({ toolName: "get_clause_detail", content: long, isError: false })) as {
			content: string;
		};
		expect(detail.content).toContain("已截断,原长 200 字符");
		expect(detail.content.startsWith("x".repeat(20))).toBe(true);

		const other = (await handler({ toolName: "unknown_tool", content: long, isError: false })) as { content: string };
		expect(other.content.startsWith("x".repeat(40))).toBe(true);
	});

	it("carries details / isError / usage through — this file's own contract, not a documented pi guarantee", async () => {
		// 这不是在断言 pi 的合并机制就是"逐字段全量替换、无 deep merge"——实测
		// ExtensionRunner.emitToolResult(packages/coding-agent/src/core/extensions/runner.ts:
		// 872-925)对这三个字段其实是"undefined 就不覆盖、保留原值"的条件合并,并非无差别
		// 清空,但那是未文档化的实现细节。这条用例锁的是本文件自己的、不依赖该细节的更严格
		// 契约:这个单测直接读 handler 的返回值、不做任何合并,漏回填一个字段在这里就是
		// 拿到 undefined,等价于把它清空。见 result-budget.ts 对应处的注释。
		const handler = instantiate(OPTIONS);
		const out = (await handler({
			toolName: "get_clause_detail",
			content: "x".repeat(200),
			details: { citation: "A-1" },
			isError: true,
			usage: { tokens: 12 },
		})) as Record<string, unknown>;
		expect(out.details).toEqual({ citation: "A-1" });
		expect(out.isError).toBe(true);
		expect(out.usage).toEqual({ tokens: 12 });
	});

	it("leaves non-JSON content alone apart from the character cap", async () => {
		const handler = instantiate({ maxHits: {}, maxChars: { default: 10_000 } });
		const out = (await handler({ toolName: "search_policy", content: "纯文本结果", isError: false })) as {
			content: string;
		};
		expect(out.content).toBe("纯文本结果");
	});

	// 护栏口径的边界凭证:实测值不截、阈值 +1 截。这是 result-budget 在
	// 当前语料下唯一的「它真的会截」的证据 —— spec 的阈值本身永不触发。
	// 7700 = get_clause_detail 真环境实测 5491 字符(8 个 clause_id 一次取全,见
	// specs/policy-query.json 的 $comment)× 1.4 向上取整到百位。
	it("leaves the measured payload untouched and truncates one char past the guardrail", async () => {
		const handler = instantiate({ maxHits: {}, maxChars: { get_clause_detail: 7700 } });
		const measured = (await handler({
			toolName: "get_clause_detail",
			content: "x".repeat(5491),
			isError: false,
		})) as { content: string };
		expect(measured.content).not.toContain("已截断");

		const over = (await handler({
			toolName: "get_clause_detail",
			content: "x".repeat(7701),
			isError: false,
		})) as { content: string };
		expect(over.content).toContain("已截断,原长 7701 字符");
	});

	// pi 真实的 tool_result 事件把 content 定成 (TextContent | ImageContent)[]——见
	// result-budget.ts 里 extractText / rewrapContent 的注释:agent-session.js 的
	// afterToolCall 钩子直接透传 AgentToolResult.content,而 task-runtime 自己的 MCP
	// 适配层(toolsets/mcp/adapter.ts)产出的 AgentToolResult 固定是单元素
	// `[{ type: "text", text }]`。上面几条用例喂的都是裸字符串,只覆盖了单测自己的输入
	// 习惯;这一条专门盯住"喂真实形状的数组,预算逻辑照样生效,且原样按数组封回去"——
	// 删掉 extractText/rewrapContent 的形状适配、退回 `event.content ?? ""` 会让这条
	// 用例翻红(content.trim is not a function)。
	it("also budgets pi's real array-shaped content and mirrors the array shape back", async () => {
		const handler = instantiate({ maxHits: { search_policy: 2 }, maxChars: { default: 10_000 } });
		const payload = JSON.stringify({ total: 5, hits: [1, 2, 3, 4, 5] });
		const out = (await handler({
			toolName: "search_policy",
			content: [{ type: "text", text: payload }],
			isError: false,
		})) as { content: Array<{ type: string; text: string }> };
		expect(Array.isArray(out.content)).toBe(true);
		const parsed = JSON.parse(out.content[0].text) as {
			hits: number[];
			_truncated: { total: number; shown: number };
		};
		expect(parsed.hits).toEqual([1, 2]);
		expect(parsed._truncated).toMatchObject({ total: 5, shown: 2 });
	});
});
