import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import {
	createFastPathRuntime,
	deriveFastSpec,
	type FastPathRuntimeOptions,
	judgeFastPathOutput,
	parseRewriteTerms,
} from "../src/runtime/fast-path-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const SCHEMA = {
	type: "object",
	required: ["conclusion", "basis", "finish_reason", "confidence"],
	properties: {
		conclusion: { type: "string" },
		finish_reason: { enum: ["stop", "refused"] },
		confidence: { enum: ["high", "medium", "low"] },
		exhausted_scope: { type: "array", items: { type: "string" } },
		basis: {
			type: "array",
			items: { type: "object", required: ["clause_id"], properties: { clause_id: { type: "string" } } },
		},
	},
} as const;

const body = (o: Record<string, unknown>) => "```json\n" + JSON.stringify(o) + "\n```";
const GOOD = { conclusion: "c", finish_reason: "stop", confidence: "high", basis: [{ clause_id: "A-1" }] };

describe("judgeFastPathOutput", () => {
	it("accepts a fully conforming answer", () => {
		expect(judgeFastPathOutput(body(GOOD), SCHEMA, ["A-1"])).toEqual({ accept: true });
	});

	it("escalates when the contract check fails", () => {
		const got = judgeFastPathOutput(body({ ...GOOD, basis: [{ clause_id: "臆造" }] }), SCHEMA, ["A-1"]);
		expect(got.accept).toBe(false);
		if (!got.accept) expect(got.reason).toContain("臆造");
	});

	it("escalates on finish_reason refused", () => {
		const refused = {
			conclusion: "c",
			finish_reason: "refused",
			confidence: "high",
			basis: [],
			exhausted_scope: ["外规"],
		};
		const got = judgeFastPathOutput(body(refused), SCHEMA, []);
		expect(got.accept).toBe(false);
		if (!got.accept) expect(got.reason).toContain("finish_reason");
	});

	it("escalates on confidence low", () => {
		const got = judgeFastPathOutput(body({ ...GOOD, confidence: "low" }), SCHEMA, ["A-1"]);
		expect(got.accept).toBe(false);
		if (!got.accept) expect(got.reason).toContain("confidence");
	});

	it("escalates when stop is paired with an empty basis (caught by criterion 1)", () => {
		// finish_reason:"stop" + basis:[] 被判据 1 的 `checkConditional` 拦下,这条锁的是
		// 「拦得住」,不是判据 4(basis 非空)自己的分支——判据 4 能不能被这条用例走到,
		// 见 src/runtime/fast-path-runtime.ts 判据 4 上方的注释。
		const got = judgeFastPathOutput(body({ ...GOOD, basis: [] }), SCHEMA, []);
		expect(got.accept).toBe(false);
	});
});

// C-4:上面全部用例都用简化 fixture SCHEMA,从未接触出厂 schema —— 这条用出厂 schema 判一份
// 合格答案,确保简化 fixture 与出厂 schema 的行为不会静默分叉。
const shippedSchema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-query/output-contract.schema.json", import.meta.url)), "utf8"),
);

describe("judgeFastPathOutput(出厂 schema)", () => {
	it("accepts a fully conforming answer under the shipped schema", () => {
		expect(judgeFastPathOutput(body(GOOD), shippedSchema, ["A-1"])).toEqual({ accept: true });
	});
});

describe("parseRewriteTerms", () => {
	it("reads a fenced JSON object with a queries array", () => {
		expect(parseRewriteTerms('```json\n{"queries":["证券公司 员工 展业","招揽客户 开户"]}\n```')).toEqual([
			"证券公司 员工 展业",
			"招揽客户 开户",
		]);
	});

	it("reads a bare JSON object", () => {
		expect(parseRewriteTerms('{"queries":["a","b"]}')).toEqual(["a", "b"]);
	});

	it("returns [] for unparsable text", () => {
		expect(parseRewriteTerms("我觉得应该这样搜")).toEqual([]);
	});

	it("drops non-string and blank entries", () => {
		expect(parseRewriteTerms('{"queries":["a", 7, "", "  ", "b"]}')).toEqual(["a", "b"]);
	});

	it("returns [] when the queries field is missing (extractJsonBlock only recognizes {}, not [] — model must emit an object)", () => {
		expect(parseRewriteTerms('{"terms":["a","b"]}')).toEqual([]);
	});
});

describe("deriveFastSpec", () => {
	const spec: RuntimeSpec = {
		id: "pq",
		model: { role: "main" },
		toolset: "t",
		tools: ["search_policy"],
		thinkingLevel: "medium",
		limits: { maxTurns: 30, maxCostUsd: 0.5 },
		resultPolicy: { name: "result-budget", options: { maxChars: { get_clause_detail: 7700 } } },
		fastPath: {
			enabled: true,
			systemPrompt: "sys",
			rewritePrompt: "rw",
			answerPrompt: "ans",
			maxClauses: 12,
			limits: { maxCostUsd: 0.1 },
			thinkingLevel: "off",
			maxChars: { get_clause_detail: 11500 },
		},
	};

	it("swaps in the fast system prompt and drops appendSystemPrompt", () => {
		const got = deriveFastSpec(spec);
		expect(got.systemPrompt).toBe("sys");
		expect(got.appendSystemPrompt).toBeUndefined();
	});

	it("takes limits, thinkingLevel and maxChars from fastPath", () => {
		const got = deriveFastSpec(spec);
		expect(got.limits).toEqual({ maxCostUsd: 0.1 });
		expect(got.thinkingLevel).toBe("off");
		// `resultPolicy` 的静态类型是 `PluginRef | undefined`(`PluginRef` 含 `string` 变体),
		// 与 `{ options: {...} }` 没有足够的结构重叠,直接断言会被 tsgo 拒绝;先过一道 `unknown`
		// 是 TS 自己给的标准写法,不是绕过检查。
		expect((got.resultPolicy as unknown as { options: { maxChars: unknown } }).options.maxChars).toEqual({
			get_clause_detail: 11500,
		});
	});

	it("drops stopPolicy so C3 is not mounted on the fast path", () => {
		const got = deriveFastSpec({ ...spec, stopPolicy: { name: "sufficiency-gate" } });
		expect(got.stopPolicy).toBeUndefined();
	});

	it("drops outputContract so no C6 judge is registered", () => {
		const got = deriveFastSpec({ ...spec, outputContract: { schema: "s.json" } });
		expect(got.outputContract).toBeUndefined();
	});
});

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

interface FastOpts {
	modelReplies: string[];
	hitCount?: number;
	maxClauses?: number;
	onToolCall?: (name: string, args: Record<string, unknown>) => void;
	/** 让指定工具抛错,验规格 §7 的「阶段 1 抛错 ⇒ 升级」。 */
	toolThrows?: "search_policy" | "get_clause_detail";
}

/** 模型①的改写词回复:约定形状是 `{"queries": [...]}`(与 parseRewriteTerms 的文档同一份约定)。 */
function rewriteReply(terms: string[]): string {
	return body({ queries: terms });
}

/** 模型②的作答回复。默认引用 "C-1" —— fastOptions() 的 get_clause_detail 对任何请求到的
 *  clause_id 都会原样回正文,所以 "C-1" 在除"检索无命中"/"阶段 1 抛错"外的每个用例里都真实
 *  存在于 clauseIds 里。 */
function answerReply(clauseId = "C-1"): string {
	return body({ ...GOOD, basis: [{ clause_id: clauseId }] });
}

async function fastOptions(o: FastOpts): Promise<FastPathRuntimeOptions> {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	// faux 按顺序吐:第一次 prompt 拿 modelReplies[0](改写词),第二次拿 [1](作答 JSON)。
	harness.faux.setResponses(o.modelReplies.map((reply) => fauxAssistantMessage(reply)));

	const hitCount = o.hitCount ?? 3;
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "search_policy",
			label: "search_policy",
			description: "faux",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				o.onToolCall?.("search_policy", params);
				const hits = Array.from({ length: hitCount }, (_, i) => ({
					clause_id: `C-${i + 1}`,
					text: null,
					score: 0.03,
					source_code: "S",
					source_doc_id: "D",
					corpus_type: "P-EXT",
					clause_path: `第${i + 1}条`,
				}));
				const payload = JSON.stringify({ hits, total: hits.length, text_available: false, _hint: "" });
				return { output: payload, content: payload };
			},
		} as never,
		{
			name: "get_clause_detail",
			label: "get_clause_detail",
			description: "faux",
			parameters: Type.Object({ clause_ids: Type.Array(Type.String()) }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				o.onToolCall?.("get_clause_detail", params);
				if (o.toolThrows === "get_clause_detail") throw new Error("faux get_clause_detail 炸了");
				const ids = params.clause_ids as string[];
				const items = ids.map((clause_id) => ({
					clause_id,
					doc_title: "某规则",
					clause_path: clause_id,
					status: "effective",
					source_code: "S",
					source_doc_id: "D",
					version: null,
					page_start: null,
					page_end: null,
					text: `${clause_id} 的正文`,
				}));
				const payload = JSON.stringify({ items, rejected: [], not_found: [] });
				return { output: payload, content: payload };
			},
		} as never,
	]);

	return {
		spec: {
			id: "pq",
			model: { role: "main" },
			toolset: "demo",
			tools: ["search_policy", "get_clause_detail"],
			limits: { maxCostUsd: 1 },
			fastPath: {
				enabled: true,
				// ⚠ 这三个在生产上是路径,但 resolveSpecPromptPaths 在**构造期**已把它们读成正文,
				// createFastPathRuntime 拿到的就是正文。测试直接给正文,与生产形态一致。
				systemPrompt: "你是制度查询助手。",
				rewritePrompt: '把问题改写成检索词,只输出 JSON 对象 {"queries": [...]}。',
				answerPrompt: "依据下面的条款作答,输出契约 JSON。",
				maxClauses: o.maxClauses ?? 12,
				limits: { maxCostUsd: 1 },
			},
		},
		profile,
		registry: createDefaultPluginRegistry(),
		toolsets: registry,
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		outputContractSchema: SCHEMA,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	};
}

describe("createFastPathRuntime", () => {
	it("makes exactly two model calls and never exposes tools to the model", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const rt = await createFastPathRuntime(
			await fastOptions({
				onToolCall: (name, args) => {
					calls.push({ name, args });
				},
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");

		expect(got.verdict).toEqual({ accept: true });
		expect(got.result.status).toBe("completed");
		// 抢跑一次 + 改写词一次 + 批量取正文一次
		expect(calls.map((c) => c.name)).toEqual(["search_policy", "search_policy", "get_clause_detail"]);
		// 批量:一次调用带上全部 clause_id,不是一条一次
		expect((calls[2]!.args.clause_ids as string[]).length).toBeGreaterThan(1);
	});

	it("caps the fetched clause_ids at fastPath.maxClauses", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const rt = await createFastPathRuntime(
			await fastOptions({
				onToolCall: (name, args) => {
					calls.push({ name, args });
				},
				hitCount: 30,
				maxClauses: 12,
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		await rt.runFast("原始问题");
		expect((calls[2]!.args.clause_ids as string[]).length).toBe(12);
	});

	it("falls back to the head-start hits when the rewrite is unparsable — and does NOT escalate", async () => {
		const calls: string[] = [];
		const rt = await createFastPathRuntime(
			await fastOptions({
				onToolCall: (name) => {
					calls.push(name);
				},
				modelReplies: ["我觉得应该这样搜", answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict).toEqual({ accept: true });
		// 只有抢跑那一次检索,没有改写词检索
		expect(calls).toEqual(["search_policy", "get_clause_detail"]);
	});

	it("escalates when retrieval returns nothing", async () => {
		const rt = await createFastPathRuntime(
			await fastOptions({
				hitCount: 0,
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("检索");
	});

	it("escalates instead of failing when stage 1 throws", async () => {
		const rt = await createFastPathRuntime(
			await fastOptions({
				toolThrows: "get_clause_detail",
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		// 关键:抛错转成**升级判决**,不是让 runFast 自己 reject —— 阶段 2 还没跑过,
		// 现在就宣告失败等于放弃了唯一能答对的那条路径。
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("抛错");
	});

	it("counts ONLY the clause_ids whose text was fetched as retrieved (anti-hallucination source)", async () => {
		// 命中 30 条、只取 12 条正文 ⇒ 引用第 20 条必须被判臆造
		const rt = await createFastPathRuntime(
			await fastOptions({
				hitCount: 30,
				maxClauses: 12,
				modelReplies: [rewriteReply(["改写词一"]), answerReply("C-20")],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("C-20");
	});

	it("deactivates every tool before the first prompt", async () => {
		const rt = await createFastPathRuntime(await fastOptions({ modelReplies: [rewriteReply(["x"]), answerReply()] }));
		cleanups.push(rt.dispose);
		// 测试缝:锁住 setActiveToolsByName([]) 那一行 —— faux 模型本来就不调工具,
		// 删掉那行不会有任何别的用例翻红,必须有这一条直接断言。
		expect(rt.activeToolNamesForTest()).toEqual([]);
	});
});
