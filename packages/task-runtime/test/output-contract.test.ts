import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOutputContractJudge, extractJsonBlock } from "../src/runtime/output-contract.ts";

const SCHEMA = {
	type: "object",
	required: ["conclusion", "basis", "confidence", "finish_reason"],
	additionalProperties: false,
	properties: {
		conclusion: { type: "string", minLength: 1 },
		basis: {
			type: "array",
			items: {
				type: "object",
				required: ["clause_id"],
				additionalProperties: false,
				properties: {
					clause_id: { type: "string" },
					chunk_id: { type: "string" },
					source_code: { type: ["string", "null"] },
					source_doc_id: { type: ["string", "null"] },
					score: { type: ["number", "null"] },
					corpus_type: { enum: ["internal", "external", "qa", "case"] },
				},
			},
		},
		reasoning: { type: "string" },
		confidence: { enum: ["high", "medium", "low"] },
		finish_reason: { enum: ["stop", "refused"] },
		exhausted_scope: { type: "array", items: { type: "string" } },
		gaps: { type: "array", items: { type: "string" } },
	},
};

const judge = createOutputContractJudge({ schema: SCHEMA, maxRepairAttempts: 2 });

const good = {
	conclusion: "允许",
	basis: [{ clause_id: "A-1", corpus_type: "internal" }],
	confidence: "high",
	finish_reason: "stop",
};

describe("extractJsonBlock", () => {
	it("reads a bare JSON object", () => {
		expect(extractJsonBlock('{"a":1}')).toEqual({ kind: "ok", value: { a: 1 } });
	});

	it("reads a fenced ```json block", () => {
		expect(extractJsonBlock('前言\n```json\n{"a":1}\n```\n后记')).toEqual({ kind: "ok", value: { a: 1 } });
	});

	it("reads an unlabelled fenced block", () => {
		expect(extractJsonBlock('```\n{"a":1}\n```')).toEqual({ kind: "ok", value: { a: 1 } });
	});

	// 审查订正:这是唯一真的会走到"原文本兜底"分支、并且**成功**的场景 —— 围栏内容本身
	// 不含花括号(第一个候选在 start<0 处 continue),回退到原文本才截出紧跟其后的裸 JSON。
	it("reads a bare JSON object that follows an unlabelled non-JSON fence", () => {
		expect(extractJsonBlock('```\nsome cmd\n```\n{"a":1}')).toEqual({ kind: "ok", value: { a: 1 } });
	});

	// absent 与 unparsable 必须分开:前者无解析错误可报(模型输出纯散文),后者有。
	// 合并成一个 undefined 正是本任务要消除的信息损失。
	it("reports absent when there is no brace at all", () => {
		expect(extractJsonBlock("完全是散文")).toEqual({ kind: "absent" });
	});

	it("reports unparsable with the parser message when braces exist but JSON is broken", () => {
		const broken = '{"conclusion":"甲" "basis":[]}'; // 缺逗号,与第 7 次真 run 同型
		const result = extractJsonBlock(broken);
		expect(result.kind).toBe("unparsable");
		if (result.kind === "unparsable") {
			expect(result.error).toMatch(/JSON/);
			expect(result.snippet).toContain('"basis"');
		}
	});

	// 长输入时 snippet 必须围绕出错位置截,而不是恒取开头 —— 第 7 次真 run 的错误在
	// char 2532,恒取开头等于把人指向一段完全正确的文本。
	it("centres the snippet on the parser's reported position", () => {
		const filler = '{"pad":"' + "x".repeat(500) + '" "boom":1}';
		const result = extractJsonBlock(filler);
		expect(result.kind).toBe("unparsable");
		if (result.kind === "unparsable") {
			expect(result.snippet).toContain('"boom"');
			expect(result.snippet.length).toBeLessThanOrEqual(161);
		}
	});
});

describe("output contract judge", () => {
	it("declares maxAttempts from maxRepairAttempts and errors when exhausted", () => {
		expect(judge.maxAttempts).toBe(2);
		expect(judge.onExhausted).toBe("error");
	});

	it("passes a well-formed answer whose clause ids were actually retrieved", async () => {
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(good), clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(true);
	});

	it("rejects prose with the absent-block wording and no fake parser detail", async () => {
		const verdict = await judge.judge({ lastAssistantText: "散文", clauseIds: [] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.detail).toContain("未找到 JSON");
			expect(verdict.followUp).not.toMatch(/position/);
		}
	});

	// 第 7 次真 run 的形态:有花括号、JSON 坏了。followUp 必须带解析位置,
	// 否则模型只知道"不对",不知道错在哪个字符。
	it("rejects broken JSON with the parser message and the surrounding snippet", async () => {
		const verdict = await judge.judge({
			lastAssistantText: '{"conclusion":"甲" "basis":[]}',
			clauseIds: [],
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.detail).toContain("JSON 解析失败");
			expect(verdict.followUp).toContain('"basis"');
		}
	});

	// 第 7 次真 run 的字段名形态:顶层键全是模型自己发明的。
	it("names the missing and extra top-level keys when the model invents its own field names", async () => {
		const invented = { topic: "开户", summary: "不允许", clauses: [] };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(invented), clauseIds: [] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.followUp).toContain("conclusion");
			expect(verdict.followUp).toContain("topic");
		}
	});

	// 第 5 次真 run 的形态:错在 /basis/0。差集必须算在那一层,
	// 恒取顶层会给出一份与病因无关的差集。
	it("computes the key diff at the failing instancePath, not always at the root", async () => {
		const withText = {
			...good,
			basis: [{ clause_id: "A-1", text: "第一条 …条款原文…" }],
		};
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(withText), clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.followUp).toContain("text");
			// 顶层是合规的 —— 差集不得把顶层必填键报成缺失。
			expect(verdict.followUp).not.toContain("缺少 conclusion");
		}
	});

	// 非对象层的错误(enum 违规)没有键差集可算,followUp 退回只带 instancePath。
	// 硬造一份差集比不给更糟 —— 模型会去改一个没错的字段。
	it("falls back to the instancePath alone when the failing node is not an object", async () => {
		const bad = { ...good, confidence: "very-high" };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(bad), clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.detail).toContain("/confidence");
			expect(verdict.followUp).not.toContain("缺少");
		}
	});

	// 上面那条"falls back"用例是重言式:confidence 是裸 enum,schema 那一层压根没有
	// properties 键,不管 keyDiffAt 对不对都会走到"properties === undefined"提前返回。
	// 真正需要盯住的是 keyDiffAt 里 `!isRecord(current)` 那个防崩溃守卫——failing 节点的
	// schema 有 properties(basis 元素是 object schema),但实际值不是对象:第 5 次真 run
	// 的另一种跑偏,模型把整个 basis 元素写成裸字符串而不是对象。少了这个守卫,
	// `required.filter((key) => !(key in current))` 会对着字符串做 `in`,直接抛
	// TypeError,而不是退回一份只带 instancePath 的 followUp。
	it("does not throw and falls back to the instancePath alone when a basis element is not an object", async () => {
		const bad = { ...good, basis: ["纯文本"] };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(bad), clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.detail).toContain("/basis/0");
			expect(verdict.followUp).not.toContain("缺少");
		}
	});

	it("rejects finish_reason:stop with an empty basis", async () => {
		const bad = { ...good, basis: [] };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(bad), clauseIds: [] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.detail).toContain("basis");
	});

	it("rejects finish_reason:refused with an empty exhausted_scope", async () => {
		const bad = { ...good, basis: [], finish_reason: "refused" };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(bad), clauseIds: [] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.detail).toContain("exhausted_scope");
	});

	it("accepts finish_reason:refused with a non-empty exhausted_scope and no basis", async () => {
		const refused = { ...good, basis: [], finish_reason: "refused", exhausted_scope: ["内规库"] };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(refused), clauseIds: [] });
		expect(verdict.ok).toBe(true);
	});

	it("rejects a hallucinated clause_id that was never retrieved", async () => {
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(good), clauseIds: ["B-9"] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.detail).toContain("A-1");
			expect(verdict.followUp).toContain("检索结果");
		}
	});

	// 审查 Important-1 的回归锁:一句看起来完全合理的重构——
	// `if (clauseIds.length === 0) return undefined;`("没检索到就别为难模型")——
	// 会整段删掉风险 10 的兜底,而原有的反幻觉用例只用了非空 clauseIds(["B-9"]),
	// 拦不住这种重构。clauseIds 全空、basis 引用了任意 clause_id 时必须照样判失败,
	// 而且 detail 要能把人指向真正的病因(检索结果为空,不是模型编造)。
	it("rejects a referenced clause_id when clauseIds is empty, and names the empty-retrieval cause", async () => {
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(good), clauseIds: [] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.detail).toContain("A-1");
			expect(verdict.detail).toContain("本次检索结果为空");
		}
	});
});

const shippedSchema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-query/output-contract.schema.json", import.meta.url)), "utf8"),
);
const shippedJudge = createOutputContractJudge({ schema: shippedSchema, maxRepairAttempts: 2 });

describe("A8 反幻觉兜底(出厂 schema)", () => {
	// output-contract.ts:42-59 那条寄生前提唯一可执行的凭证 —— 代码层面强制不了
	// (draft-07 的 required 可以藏在 $ref/allOf/oneOf 后面,静态查全等于自己写半个
	// schema 解析器)。守它的是这条用例。
	it("rejects a basis clause_id that was never retrieved in this run", async () => {
		const answer = {
			conclusion: "不允许",
			basis: [{ clause_id: "FAKE-999" }],
			confidence: "high",
			finish_reason: "stop",
		};
		const verdict = await shippedJudge.judge({
			lastAssistantText: JSON.stringify(answer),
			clauseIds: ["REAL-1"],
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.detail).toContain("FAKE-999");
	});

	// A8 变异检验实测偏离(task-18):上面那条用例的 payload(clause_id 键存在、值是
	// 编造的 "FAKE-999")在 checkConditional 里走的是"这个 id 不在 retrieved 里"分支——
	// 这条分支只看解析后的 JSON 值,根本不读 schema,所以对 basis.items.required 去掉
	// clause_id 这个变异**不敏感**:实测过,删掉 required 后这条用例原样返回
	// { ok:false, detail 含 "FAKE-999" },一字不差。schema 自己的 $comment 说得很清楚,
	// 寄生前提真正兜的是"元素不带 clause_id 这个键时 invented 为空、直接放行"——
	// 那必须是键缺失,不是键存在但值是假的。下面这条才是对 required 变异真正敏感的用例:
	// 去掉 required 后 schema 校验不再拦"没有 clause_id 键"的元素,checkConditional 也
	// 读不出字符串 id(invented 为空),两道防线一起失守,判官改口放行。
	it("rejects a basis element that omits clause_id entirely (the mutation-sensitive case)", async () => {
		const answer = {
			conclusion: "不允许",
			basis: [{}],
			confidence: "high",
			finish_reason: "stop",
		};
		const verdict = await shippedJudge.judge({
			lastAssistantText: JSON.stringify(answer),
			clauseIds: ["REAL-1"],
		});
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.detail).toContain("clause_id");
	});
});
