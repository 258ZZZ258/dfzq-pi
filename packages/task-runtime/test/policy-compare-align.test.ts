import { describe, expect, it } from "vitest";
import {
	alignBatchCandidates,
	alignClauses,
	alignInternalToExternalBatchCandidates,
	normalizeClauseKey,
} from "../src/runtime/policy-compare/align.ts";
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

	// Finding 3: 两位数及以上中文数字覆盖 cnToInt 的主分支
	it("两位数中文数字:第二十条 与 第20条 归一后相等", () => {
		expect(normalizeClauseKey("第二十条")).toBe(normalizeClauseKey("第20条"));
	});

	it("三位数中文数字:第一百零五条 与 第105条 归一后相等", () => {
		expect(normalizeClauseKey("第一百零五条")).toBe(normalizeClauseKey("第105条"));
	});

	it("三位数中文数字:第一百二十三条 与 第123条 归一后相等", () => {
		expect(normalizeClauseKey("第一百二十三条")).toBe(normalizeClauseKey("第123条"));
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

	// Finding 1: 上传件文档为空数组,clause_path 为 null → 应进 unmatched
	it("文档为空数组(clauses: []),source_law clause_path 为 null → unmatched with reason 'uploaded_document_has_no_clauses'", () => {
		const emptyDoc: ExternalDocument = {
			uploadId: "U2",
			title: "空文档",
			docNo: "测试〔2026〕99号",
			clauses: [],
		};
		const got = alignClauses(
			emptyDoc,
			[ob("G")],
			[
				{
					chunkId: "G",
					sourceLaws: [{ docNo: "测试〔2026〕99号", docTitle: null, clausePath: null, sourceCode: "X" }],
				},
			],
		);
		expect(got.pairs).toEqual([]);
		expect(got.unmatched).toEqual([{ internalChunkId: "G", reason: "uploaded_document_has_no_clauses" }]);
	});

	// Finding 2: 多条 sourceLaws,前两条文档不匹配,第三条对得上
	it("sourceLaws 有多条,前两条文档不匹配,第三条对得上 → 产出 1 pair 用第三条", () => {
		const got = alignClauses(
			doc,
			[ob("H")],
			[
				{
					chunkId: "H",
					sourceLaws: [
						{ docNo: "无关法规A", docTitle: null, clausePath: "第一条", sourceCode: "X1" },
						{ docNo: null, docTitle: "无关法规B", clausePath: "第二条", sourceCode: "X2" },
						{
							docNo: "证监发〔2026〕1号",
							docTitle: null,
							clausePath: "第二章 报销原则/第五条",
							sourceCode: "X3",
						},
					],
				},
			],
		);
		expect(got.pairs).toHaveLength(1);
		expect(got.pairs[0].matchKind).toBe("exact");
		expect(got.pairs[0].externalClause.seq).toBe(0);
		expect(got.unmatched).toEqual([]);
	});

	// Finding 2: 多条 sourceLaws,都指向本文档但 clause_path 都查不到
	it("sourceLaws 有多条都指向本文档,但全部 clause_path 在上传件中查不到 → unmatched", () => {
		const got = alignClauses(
			doc,
			[ob("I")],
			[
				{
					chunkId: "I",
					sourceLaws: [
						{
							docNo: "证监发〔2026〕1号",
							docTitle: null,
							clausePath: "第四章 不存在/第九十九条",
							sourceCode: "X1",
						},
						{
							docNo: "证监发〔2026〕1号",
							docTitle: null,
							clausePath: "第五章 也不存在/第一百条",
							sourceCode: "X2",
						},
					],
				},
			],
		);
		expect(got.pairs).toEqual([]);
		expect(got.unmatched).toEqual([{ internalChunkId: "I", reason: "external_clause_not_in_uploaded_document" }]);
	});
});

describe("alignBatchCandidates", () => {
	it("每条外规只配对本条批量检索到的内规候选，空候选显式标为缺失", () => {
		const got = alignBatchCandidates(doc, [
			{
				queryIndex: 0,
				candidates: [ob("C-1")],
				error: null,
			},
			{ queryIndex: 1, candidates: [], error: null },
		]);

		expect(got.countBy).toBe("external");
		expect(got.pairs).toHaveLength(1);
		expect(got.pairs[0].externalClause.seq).toBe(0);
		expect(got.pairs[0].matchKind).toBe("semantic_retrieval");
		expect(got.uncoveredExternalClauses).toEqual([{ externalClause: doc.clauses[1], reason: "no_internal_candidate" }]);
	});
});

describe("alignInternalToExternalBatchCandidates", () => {
	it("按待核查内规条款分组；没有外规候选也保留为未匹配", () => {
		const got = alignInternalToExternalBatchCandidates(
			[
				{ seq: 0, clausePath: "第一条", text: "说明性内规条款也应参与语义检索" },
				{ seq: 1, clausePath: "第二条", text: "第二条内规正文" },
			],
			[
				{ queryIndex: 0, candidates: [ob("EXT-1")], error: null },
				{ queryIndex: 1, candidates: [], error: null },
			],
			"待核查内规",
		);

		expect(got.countBy).toBe("internal");
		expect(got.pairs).toHaveLength(1);
		expect(got.pairs[0].internalObligation.text).toBe("说明性内规条款也应参与语义检索");
		expect(got.unmatched).toEqual([
			{ internalChunkId: "source-internal:1:1", reason: "no_external_candidate" },
		]);
	});
});
