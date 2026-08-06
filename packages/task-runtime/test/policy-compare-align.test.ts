import { describe, expect, it } from "vitest";
import { alignClauses, normalizeClauseKey } from "../src/runtime/policy-compare/align.ts";
import type { ExternalDocument, InternalObligation } from "../src/runtime/policy-compare/types.ts";

const doc: ExternalDocument = {
	uploadId: "U1",
	title: "证券经营机构费用报销合规要求",
	docNo: "证监发〔2026〕1号",
	clauses: [
		{ seq: 0, clausePath: "第二章 报销原则/第五条", text: "报销凭证应当在三个月内提交。" },
		{ seq: 1, clausePath: "第三章 审批规则/第十条", text: "超过一万元的报销应当经分管领导审批。" },
	],
};

const ob = (chunkId: string): InternalObligation => ({
	chunkId,
	clausePath: "第三章/第八条",
	docTitle: "费用报销管理办法",
	docNo: "东方证券〔2026〕7号",
	deonticType: "obligation",
	evidence: "应当",
	text: `${chunkId} 的内规正文`,
	sourceCode: `SC-${chunkId}`,
});

describe("normalizeClauseKey", () => {
	it("全角转半角、去空白", () => {
		expect(normalizeClauseKey("第三章　／　第十条")).toBe(normalizeClauseKey("第三章/第十条"));
	});

	it("中文数字转阿拉伯数字", () => {
		expect(normalizeClauseKey("第十条")).toBe(normalizeClauseKey("第10条"));
	});

	it("null 归一成空串", () => {
		expect(normalizeClauseKey(null)).toBe("");
	});
});

describe("alignClauses", () => {
	it("(doc_no, clause_path) 精确相等 → exact", () => {
		const got = alignClauses(
			doc,
			[ob("A")],
			[
				{
					chunkId: "A",
					sourceLaws: [
						{ docNo: "证监发〔2026〕1号", docTitle: null, clausePath: "第二章 报销原则/第五条", sourceCode: "X" },
					],
				},
			],
		);
		expect(got.unmatched).toEqual([]);
		expect(got.pairs).toHaveLength(1);
		expect(got.pairs[0].matchKind).toBe("exact");
		expect(got.pairs[0].externalClause.seq).toBe(0);
	});

	it("doc_no 对不上但归一后的 (doc_title, clause_path) 相等 → normalized", () => {
		const got = alignClauses(
			doc,
			[ob("B")],
			[
				{
					chunkId: "B",
					sourceLaws: [
						{
							docNo: "别的号",
							docTitle: "证券经营机构费用报销合规要求",
							clausePath: "第三章 审批规则/第十条",
							sourceCode: "X",
						},
					],
				},
			],
		);
		expect(got.pairs).toHaveLength(1);
		expect(got.pairs[0].matchKind).toBe("normalized");
		expect(got.pairs[0].externalClause.seq).toBe(1);
	});

	it("clause_path 为 null(映射粒度是文档级)→ doc_level,与该文档全部条款成对", () => {
		const got = alignClauses(
			doc,
			[ob("C")],
			[
				{
					chunkId: "C",
					sourceLaws: [{ docNo: "证监发〔2026〕1号", docTitle: null, clausePath: null, sourceCode: "X" }],
				},
			],
		);
		expect(got.pairs).toHaveLength(2);
		expect(got.pairs.every((p) => p.matchKind === "doc_level")).toBe(true);
	});

	it("对不上 → 进 unmatched,不静默丢", () => {
		const got = alignClauses(
			doc,
			[ob("D")],
			[
				{
					chunkId: "D",
					sourceLaws: [{ docNo: "另一部法规", docTitle: "另一部法规", clausePath: "第九十九条", sourceCode: "X" }],
				},
			],
		);
		expect(got.pairs).toEqual([]);
		expect(got.unmatched).toEqual([{ internalChunkId: "D", reason: "external_clause_not_in_uploaded_document" }]);
	});

	it("M2 没回这条内规的解析结果 → 也进 unmatched", () => {
		const got = alignClauses(doc, [ob("E")], []);
		expect(got.pairs).toEqual([]);
		expect(got.unmatched).toEqual([{ internalChunkId: "E", reason: "source_law_unresolved" }]);
	});

	it("不做模糊匹配:文字相近但归一后不等,仍进 unmatched", () => {
		const got = alignClauses(
			doc,
			[ob("F")],
			[
				{
					chunkId: "F",
					sourceLaws: [
						{
							docNo: null,
							docTitle: "证券经营机构费用报销合规要求",
							clausePath: "第二章 报销原则/第六条",
							sourceCode: "X",
						},
					],
				},
			],
		);
		expect(got.pairs).toEqual([]);
		expect(got.unmatched).toHaveLength(1);
	});
});
