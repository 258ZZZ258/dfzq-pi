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
});
