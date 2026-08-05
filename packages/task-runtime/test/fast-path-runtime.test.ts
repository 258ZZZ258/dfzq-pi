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
	renderEvidence,
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

// 2026-08-04 定点修复(第一刀):search_policy 原样返回 Milvus 分区码(如 "P-EXT"),模型忠实
// 抄进 basis[].corpus_type,而 output-contract.schema.json 的 corpus_type enum 只认
// {internal, external, qa, case} —— 分区码原样印进证据块必然导致模型抄写出一个 enum 校验挂不住
// 的值。这两条用例锁住 renderEvidence 的反向映射:已知分区码要翻成语义标签,未知分区码原样
// 透传(不猜、不抛)。
describe("renderEvidence", () => {
	it("maps a known Milvus partition code to the schema's corpus_type label", () => {
		const byId = new Map([["C-1", { clause_id: "C-1", corpus_type: "P-EXT", score: 0.9 }]]);
		const rendered = renderEvidence([{ clause_id: "C-1", doc_title: "某规则", text: "正文" }], byId);
		expect(rendered).toContain("corpus_type: external");
		expect(rendered).not.toContain("P-EXT");
	});

	it("passes an unrecognized partition code through unchanged rather than guessing", () => {
		const byId = new Map([["C-1", { clause_id: "C-1", corpus_type: "P-MYSTERY", score: 0.9 }]]);
		const rendered = renderEvidence([{ clause_id: "C-1", doc_title: "某规则", text: "正文" }], byId);
		expect(rendered).toContain("corpus_type: P-MYSTERY");
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
	/** fastPath.limits.runTimeoutMs 覆盖值,缺省不设(与其余用例一致,不测超时时不需要它)。 */
	runTimeoutMs?: number;
	/** fastPath.limits.maxTotalTokens 覆盖值,用来验规格 §7「阶段 1 撞 limits 插件的阈值 ⇒
	 *  升级」——测试用的 profile 计费全 0,maxCostUsd 永远撞不上,只有 token 计数能触发。 */
	maxTotalTokens?: number;
	/** 让 modelReplies[0](模型①改写词那次回复)延迟这么多 ms 才 resolve,模拟"模型①挂住"。
	 *  必须配合 runTimeoutMs 使用。 */
	hangRewriteMs?: number;
	/** 让 get_clause_detail 的 execute 延迟这么多 ms 才返回,模拟"检索阶段挂住"。 */
	hangDetailMs?: number;
	/** 让 modelReplies[1](模型②作答那次回复)延迟这么多 ms 才 resolve,模拟"模型②挂住"——
	 *  测检查点 3(promptOnce(answer) 之后、judgeFastPathOutput 之前那道复查)。 */
	hangAnswerMs?: number;
	/** 让 get_clause_detail 把这些 clause_id 判成"查不到详情"——进 not_found,不进 items。 */
	detailNotFound?: string[];
	/** 让 get_clause_detail 对这些 clause_id 返回"详情行存在但正文缺失"(C-1:text 是 null,
	 *  audit-ai 的 get_clause_detail.py:100-101"正文缺失是 null,不是错误")。 */
	detailNullText?: string[];
}

/** 模型①的改写词回复:约定形状是 `{"queries": [...]}`(与 parseRewriteTerms 的文档同一份约定)。 */
function rewriteReply(terms: string[]): string {
	return body({ queries: terms });
}

/** 模型②的作答回复。默认引用 "C-1" —— fastOptions() 的 get_clause_detail **缺省**对任何请求到
 *  的 clause_id 都原样回正文,所以不传 `detailNotFound` / `detailNullText` 的用例里,"C-1" 都
 *  真实存在于 clauseIds 里。**例外**:①"检索无命中"/"阶段 1 抛错"两条早退路径压根到不了
 *  promptOnce(answer),这个字符串本身用不用都无所谓;②用例若显式传了覆盖到 "C-1" 的
 *  `detailNotFound` / `detailNullText`(比如 "emits fast_path_escalated…" 那条用
 *  `detailNullText:["C-1","C-2","C-3"]`),"C-1" 就不再真实存在于 clauseIds 里——那类用例要么
 *  不调 `answerReply()`,要么(如上例)在到达 promptOnce(answer) 之前就已经早退,同样不受影响。 */
function answerReply(clauseId = "C-1"): string {
	return body({ ...GOOD, basis: [{ clause_id: clauseId }] });
}

async function fastOptions(o: FastOpts): Promise<FastPathRuntimeOptions> {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	// faux 按顺序吐:第一次 prompt 拿 modelReplies[0](改写词),第二次拿 [1](作答 JSON)。
	// `responses` 用 `unknown[]`(与 test/session-runtime.test.ts 的 `build()` helper 同一处理)
	// 而不是精确的 FauxResponseStep[]——`hangRewriteMs`/`hangAnswerMs` 那两个分支要塞一个零参
	// 工厂函数,零参数结构上兼容 FauxResponseFactory 的 4 参签名(TS 允许提供更少的形参),但
	// 精确标出这个联合类型没有必要,交给 setResponses 调用处的 `as never` 统一处理。
	const hangMsByIndex = [o.hangRewriteMs, o.hangAnswerMs];
	const responses: unknown[] = o.modelReplies.map((reply, index) => {
		const hangMs = hangMsByIndex[index];
		return hangMs === undefined
			? fauxAssistantMessage(reply)
			: () => new Promise((resolve) => setTimeout(() => resolve(fauxAssistantMessage(reply)), hangMs));
	});
	harness.faux.setResponses(responses as never);

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
				if (o.hangDetailMs !== undefined) await new Promise((resolve) => setTimeout(resolve, o.hangDetailMs));
				const ids = params.clause_ids as string[];
				const notFound = new Set(o.detailNotFound ?? []);
				const nullText = new Set(o.detailNullText ?? []);
				const items = ids
					.filter((clause_id) => !notFound.has(clause_id))
					.map((clause_id) => ({
						clause_id,
						doc_title: "某规则",
						clause_path: clause_id,
						status: "effective",
						source_code: "S",
						source_doc_id: "D",
						version: null,
						page_start: null,
						page_end: null,
						// C-1 fixture:audit-ai 对"anchor 存在但正文缺失"的条款回 text: null,
						// 不落 not_found(get_clause_detail.py:100-101)。
						text: nullText.has(clause_id) ? null : `${clause_id} 的正文`,
					}));
				const payload = JSON.stringify({
					items,
					rejected: [],
					not_found: ids.filter((clause_id) => notFound.has(clause_id)),
				});
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
				limits: {
					maxCostUsd: 1,
					...(o.runTimeoutMs !== undefined ? { runTimeoutMs: o.runTimeoutMs } : {}),
					...(o.maxTotalTokens !== undefined ? { maxTotalTokens: o.maxTotalTokens } : {}),
				},
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
		// M-4:用例名说"exactly two model calls",此前没有断言真的验过——turns 就是
		// promptOnce() 的调用次数(fast-path-runtime.ts 的 modelCalls)。
		expect(got.result.turns).toBe(2);
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

	it("counts ONLY clause_ids with real fetched text — excludes rows dropped by maxClauses, not_found, and text:null (anti-hallucination source; C-1/I-2)", async () => {
		// 命中 30 条、maxClauses 只留 12 条预算,再让 get_clause_detail 对其中两条回"未真正取到
		// 正文"的两种真实形态:
		//   - C-1 进 not_found(PG 查不到详情);
		//   - C-2 详情行回来了但 text 是 null(get_clause_detail.py:100-101,
		//     "正文缺失是 null,不是错误"——这类条款只有标题元数据,C-1 修复要拦的正是这个);
		//   - C-30 命中 30 条但 maxClauses 只留 12 条预算,压根没被送去 get_clause_detail。
		// 三种"未真正取到正文"的形态都必须被 clauseIds 排除,判官必须把三者都判臆造。
		// 用 C-1/C-2/C-30 而不是 C-1/C-2/C-20:C-2 是 C-20 的前缀,`toContain("C-2")` 在
		// reason 里同时出现 "C-2" 与 "C-20" 时会误判——C-30 与 C-1/C-2 互不为前缀,断言干净。
		const rt = await createFastPathRuntime(
			await fastOptions({
				hitCount: 30,
				maxClauses: 12,
				detailNotFound: ["C-1"],
				detailNullText: ["C-2"],
				modelReplies: [
					rewriteReply(["改写词一"]),
					body({ ...GOOD, basis: [{ clause_id: "C-1" }, { clause_id: "C-2" }, { clause_id: "C-30" }] }),
				],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) {
			expect(got.verdict.reason).toContain("C-1");
			expect(got.verdict.reason).toContain("C-2");
			expect(got.verdict.reason).toContain("C-30");
		}
	});

	it("deactivates every tool before the first prompt", async () => {
		const rt = await createFastPathRuntime(await fastOptions({ modelReplies: [rewriteReply(["x"]), answerReply()] }));
		cleanups.push(rt.dispose);
		// 测试缝:锁住 setActiveToolsByName([]) 那一行 —— faux 模型本来就不调工具,
		// 删掉那行不会有任何别的用例翻红,必须有这一条直接断言。
		expect(rt.activeToolNamesForTest()).toEqual([]);
	});

	// C-2 / I-1:挂钟硬顶必须在两次模型调用**之间**也生效,不能只在模型②返回之后查一次 ——
	// 否则超时期间代码会继续走完检索、发出一次完全没有上限的模型②调用,快路径存在的意义
	// (落进 Java 的 30s 窗口)反而被自己吃掉。

	it("escalates when stage 1 (the rewrite prompt) hangs past runTimeoutMs, and never fetches clause detail or dispatches stage 2", async () => {
		const calls: string[] = [];
		const rt = await createFastPathRuntime(
			await fastOptions({
				runTimeoutMs: 5,
				hangRewriteMs: 60,
				onToolCall: (name) => {
					calls.push(name);
				},
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("超时");
		// status 与 session-runtime.ts 的 classify() 同口径:tripped(含 runTimeout)一律
		// "limit_exceeded",不是 "aborted"——"aborted" 在 run-manager.ts 里专指用户主动取消,
		// docs/java-answer-contract.md:82 也把 `limit` 字段的语义钉死在
		// `status === "limit_exceeded"` 上。
		expect(got.result.status).toBe("limit_exceeded");
		expect(got.result.limit).toBe("runTimeout");
		// 只发了模型①这一次 —— checkPreempted() 在 promptOnce(rewrite) 之后立刻早退,
		// 连 get_clause_detail 都不该被调用(headStart 那次 search_policy 抢跑独立触发,
		// 不受这条早退影响,所以不断言它不出现)。
		expect(got.result.turns).toBe(1);
		expect(calls).not.toContain("get_clause_detail");
	});

	it("escalates when the wall clock trips during retrieval (between the two prompts), and still never dispatches stage 2", async () => {
		const rt = await createFastPathRuntime(
			await fastOptions({
				runTimeoutMs: 5,
				hangDetailMs: 60,
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("超时");
		expect(got.result.status).toBe("limit_exceeded");
		expect(got.result.limit).toBe("runTimeout");
		// 只发了模型①这一次 —— 若 promptOnce(answer) 之前那道早退被删掉,这里会变成 2。
		expect(got.result.turns).toBe(1);
	});

	it("escalates when the wall clock trips during stage 2 itself (checkpoint after promptOnce(answer))", async () => {
		// runTimeoutMs 与 hangAnswerMs 之间留足余量(30ms vs 150ms):模型①与三次检索(无人为
		// 延迟)必须在 30ms 内跑完,不能让计时器提前在检查点 1/2 触发——那样这条用例就退化成
		// 重复测检查点 1/2,而不是它本该测的检查点 3。上面两条 hangRewriteMs/hangDetailMs 用例
		// 用 runTimeoutMs:5 是刻意贴着"快腿"的真实延迟走,
		// 这条反过来要给"快腿"(模型①+检索)留出比它宽裕得多的余量,两种取舍互不通用。
		const rt = await createFastPathRuntime(
			await fastOptions({
				runTimeoutMs: 30,
				hangAnswerMs: 150,
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("超时");
		expect(got.result.status).toBe("limit_exceeded");
		expect(got.result.limit).toBe("runTimeout");
		// 两次模型调用都真的发生了(与前两条超时用例不同,那两条在 promptOnce(answer) 之前就
		// 早退,turns 停在 1)——这条的挂钟专门卡在模型②这一轮,必须走到 turns===2 才可能被
		// 检查点 3 拦下;若检查点 3 被删掉,这里会变成 2 但 verdict.accept 变成 true(半截/完整
		// 的 answer 文本会被正常送去 judgeFastPathOutput 判)。
		expect(got.result.turns).toBe(2);
	});

	// 规格 §7:阶段 1 撞 limits 插件维护的阈值(不止挂钟超时)也要升级。测试用的 profile 计费
	// 全 0,maxCostUsd 永远撞不上,用 maxTotalTokens 触发同一条 limitState.tripped 通路。
	it("escalates when a limits-plugin threshold trips between the two prompts (regspec §7, not just wall-clock timeout)", async () => {
		const calls: string[] = [];
		const rt = await createFastPathRuntime(
			await fastOptions({
				maxTotalTokens: 1,
				onToolCall: (name) => {
					calls.push(name);
				},
				modelReplies: [rewriteReply(["改写词一"]), answerReply()],
			}),
		);
		cleanups.push(rt.dispose);
		const got = await rt.runFast("原始问题");
		expect(got.verdict.accept).toBe(false);
		if (!got.verdict.accept) expect(got.verdict.reason).toContain("token 上限");
		expect(got.result.status).toBe("limit_exceeded");
		expect(got.result.limit).toBe("maxTotalTokens");
		expect(got.result.turns).toBe(1);
		// limits 插件的 turn_end 钩子在 promptOnce(rewrite) 返回后立刻触发,checkPreempted()
		// 的检查点 1 应该在那一刻就早退——不该再走到 get_clause_detail。
		expect(calls).not.toContain("get_clause_detail");
	});

	// I-3:抛错 / 超时 / 判负的分支,RunResult.status 都不能是 "completed" —— 否则
	// server/routes.ts 的 toWireResult 会在 run() 被接线之后把一份未过契约的 JSON 当成
	// 已校验的 answer 交给 Java。
	it('never reports status:"completed" when verdict.accept is false', async () => {
		const noHit = await createFastPathRuntime(
			await fastOptions({ hitCount: 0, modelReplies: [rewriteReply(["x"]), answerReply()] }),
		);
		cleanups.push(noHit.dispose);
		const noHitResult = await noHit.runFast("原始问题");
		expect(noHitResult.result.status).not.toBe("completed");

		const thrown = await createFastPathRuntime(
			await fastOptions({ toolThrows: "get_clause_detail", modelReplies: [rewriteReply(["x"]), answerReply()] }),
		);
		cleanups.push(thrown.dispose);
		const thrownResult = await thrown.runFast("原始问题");
		expect(thrownResult.result.status).not.toBe("completed");

		const rejected = await createFastPathRuntime(
			await fastOptions({ modelReplies: [rewriteReply(["x"]), body({ ...GOOD, confidence: "low" })] }),
		);
		cleanups.push(rejected.dispose);
		const rejectedResult = await rejected.runFast("原始问题");
		expect(rejectedResult.verdict.accept).toBe(false);
		expect(rejectedResult.result.status).not.toBe("completed");
	});

	// I-4:merged.length===0(检索无命中)与 items.length===0(命中但一条正文都取不到)这两条
	// 提前返回此前不 emit fast_path_escalated——规格 §8.1 判据 2"升级率如实记录"在这两条路径
	// 上没有任何可查询的凭证。
	it("emits fast_path_escalated for the two early-return paths (no hits / no fetched text)", async () => {
		const events: string[] = [];

		const noHit = await createFastPathRuntime(
			await fastOptions({ hitCount: 0, modelReplies: [rewriteReply(["x"]), answerReply()] }),
		);
		cleanups.push(noHit.dispose);
		noHit.subscribe((e) => events.push(e.type));
		await noHit.runFast("原始问题");
		expect(events).toContain("fast_path_escalated");

		events.length = 0;
		const noText = await createFastPathRuntime(
			await fastOptions({
				detailNullText: ["C-1", "C-2", "C-3"],
				modelReplies: [rewriteReply(["x"]), answerReply()],
			}),
		);
		cleanups.push(noText.dispose);
		noText.subscribe((e) => events.push(e.type));
		await noText.runFast("原始问题");
		expect(events).toContain("fast_path_escalated");
	});
});
