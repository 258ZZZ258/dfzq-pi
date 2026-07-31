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
		expect(extractJsonBlock('{"a":1}')).toEqual({ a: 1 });
	});

	it("reads a fenced ```json block", () => {
		expect(extractJsonBlock('前言\n```json\n{"a":1}\n```\n后记')).toEqual({ a: 1 });
	});

	it("reads an unlabelled fenced block", () => {
		expect(extractJsonBlock('```\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it("returns undefined when there is no JSON at all", () => {
		expect(extractJsonBlock("完全是散文")).toBeUndefined();
	});

	// 审查订正:这是唯一真的会走到"原文本兜底"分支、并且**成功**的场景 —— 围栏内容本身
	// 不含花括号(第一个候选在 start<0 处 continue),回退到原文本才截出紧跟其后的裸 JSON。
	// 围栏内容含花括号但解析失败的那种"损坏围栏"输入,实测原文本兜底截不出干净的 JSON
	// (原文本的 indexOf/lastIndexOf 跨度必然包住围栏里那段坏内容),不在本用例覆盖范围。
	it("reads a bare JSON object that follows an unlabelled non-JSON fence", () => {
		expect(extractJsonBlock('```\nsome cmd\n```\n{"a":1}')).toEqual({ a: 1 });
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

	it("rejects text with no JSON block", async () => {
		const verdict = await judge.judge({ lastAssistantText: "散文", clauseIds: [] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.detail).toContain("未找到 JSON");
	});

	it("rejects a schema violation", async () => {
		const bad = { ...good, confidence: "very-high" };
		const verdict = await judge.judge({ lastAssistantText: JSON.stringify(bad), clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.detail).toContain("/confidence");
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
