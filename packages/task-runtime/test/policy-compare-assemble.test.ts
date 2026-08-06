import { describe, expect, it } from "vitest";
import { buildCoverageResult } from "../src/runtime/policy-compare/assemble.ts";
import type { AlignmentResult, ClausePair } from "../src/runtime/policy-compare/types.ts";

const pair = (n: number, overrides?: Partial<ClausePair>): ClausePair => ({
	externalClause: { seq: n, clausePath: `第${n}条`, text: `外规第${n}条正文` },
	internalObligation: {
		chunkId: `C-${n}`,
		clausePath: `内第${n}条`,
		docTitle: "费用报销管理办法",
		docNo: "内〔2026〕1号",
		deonticType: "obligation",
		evidence: "应当",
		text: `内规第${n}条正文`,
		sourceCode: `SC-${n}`,
	},
	matchKind: "exact",
	...overrides,
});

const alignment = (
	pairs: ClausePair[],
	unmatchedIds: string[] = [],
	unmatchedReasons?: Record<string, string>,
): AlignmentResult => ({
	pairs,
	unmatched: unmatchedIds.map((id) => ({
		internalChunkId: id,
		reason: unmatchedReasons?.[id] ?? "external_clause_not_in_uploaded_document",
	})),
});

describe("buildCoverageResult", () => {
	it("covered 不进 rows,只进 metrics", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "covered" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows).toEqual([]);
		expect(got.metrics.covered).toBe(1);
	});

	it("partial 归 tabKey=missing,conflictType 固定「部分覆盖」", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "partial", gap: "未覆盖三个月期限", suggestion: "补期限" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows).toHaveLength(1);
		expect(got.rows[0].tabKey).toBe("missing");
		expect(got.rows[0].conflictType).toBe("部分覆盖");
		expect(got.metrics.missing).toBe(1);
	});

	it("conflict 归 tabKey=error,conflictType 用模型给的", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [
				{ pairIndex: 0, state: "conflict", conflictType: "口径冲突", gap: "口径不一致", suggestion: "统一" },
			],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].tabKey).toBe("error");
		expect(got.rows[0].conflictType).toBe("口径冲突");
		expect(got.metrics.conflict).toBe(1);
	});

	it("正文逐字来自原始数据,模型多写的一律不进 rows", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(7)]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺", suggestion: "补" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].externalClause).toBe("外规第7条正文");
		expect(got.rows[0].internalClause).toBe("内规第7条正文");
		expect(got.rows[0].basis.internalChunkId).toBe("C-7");
		expect(got.rows[0].basis.matchKind).toBe("exact");
	});

	it("index 从 1 起连续", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1)]),
			verdicts: [
				{ pairIndex: 0, state: "missing", gap: "a", suggestion: "b" },
				{ pairIndex: 1, state: "conflict", conflictType: "冲突", gap: "c", suggestion: "d" },
			],
			checkedCount: 2,
			truncated: false,
		});
		expect(got.rows.map((r) => r.index)).toEqual([1, 2]);
	});

	it("unmatched 同时进 metrics 与 gaps", () => {
		const got = buildCoverageResult({
			alignment: alignment([], ["C-9"]),
			verdicts: [],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.metrics.unmatched).toBe(1);
		expect(got.gaps?.join("\n")).toContain("C-9");
	});

	it("truncated 写进 gaps", () => {
		const got = buildCoverageResult({
			alignment: alignment([]),
			verdicts: [],
			checkedCount: 500,
			truncated: true,
		});
		expect(got.gaps?.some((g) => g.includes("截断"))).toBe(true);
	});

	it("模型漏判的一对计入 unmatched,不静默消失", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1)]),
			verdicts: [{ pairIndex: 0, state: "covered" }],
			checkedCount: 2,
			truncated: false,
		});
		expect(got.metrics.unmatched).toBe(1);
		expect(got.gaps?.join("\n")).toContain("C-1");
	});

	it("metrics 四项之和等于 checked", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1), pair(2)], ["C-9"]),
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				{ pairIndex: 1, state: "missing", gap: "a", suggestion: "b" },
				{ pairIndex: 2, state: "conflict", conflictType: "x", gap: "c", suggestion: "d" },
			],
			checkedCount: 4,
			truncated: false,
		});
		const m = got.metrics;
		expect(m.missing + m.conflict + m.covered + m.unmatched).toBe(m.checked);
	});

	// 补充覆盖:conflict 没给 conflictType 时的兜底
	it("conflict 无 conflictType 时用 JUDGEMENT_BY_STATE 兜底", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "conflict", gap: "有冲突", suggestion: "解决" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].conflictType).toBe("口径不一致");
		expect(got.rows[0].tabKey).toBe("error");
	});

	// 补充覆盖:suggestion 缺省时的默认值
	it("suggestion 缺省时为空字符串", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺了什么" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].suggestion).toBe("");
	});

	// 补充覆盖:missing 无 suggestion 的情况
	it("missing 无 suggestion 时为空字符串", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺要求" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].suggestion).toBe("");
	});

	// 补充覆盖:gap 缺省时不进 gaps
	it("verdict.gap 缺省时不在 gaps 里", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "missing" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.gaps).toEqual([]);
	});

	// 补充覆盖:partial 状态无 conflictType 时
	it("partial 必定输出「部分覆盖」,即使模型给了别的值", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [
				{
					pairIndex: 0,
					state: "partial",
					gap: "缺条件",
					suggestion: "补",
					conflictType: "应该被忽略的值",
				},
			],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].conflictType).toBe("部分覆盖");
	});

	// 补充覆盖:source 的 docTitle 为 null
	it("source 组织:docTitle 为 null 时只用 clausePath", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: "第一章第一条",
						docTitle: null,
						docNo: "规〔2024〕1号",
						deonticType: "obligation",
						evidence: "应当",
						text: "正文",
						sourceCode: "SC-0",
					},
				}),
			]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].source).toBe("第一章第一条");
	});

	// 补充覆盖:source 的 clausePath 为 null
	it("source 组织:clausePath 为 null 时只用 docTitle", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: null,
						docTitle: "管理办法",
						docNo: "规〔2024〕1号",
						deonticType: "obligation",
						evidence: "应当",
						text: "正文",
						sourceCode: "SC-0",
					},
				}),
			]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].source).toBe("管理办法");
	});

	// 补充覆盖:source 的两个字段都为 null
	it("source 两字段都 null 时为空字符串", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: null,
						docTitle: null,
						docNo: "规〔2024〕1号",
						deonticType: "obligation",
						evidence: "应当",
						text: "正文",
						sourceCode: "SC-0",
					},
				}),
			]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].source).toBe("");
	});

	// 补充覆盖:extraGaps 的合并
	it("extraGaps 与对齐/模型 gap 一起进 gaps", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)], ["C-9"]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺了条件" }],
			checkedCount: 2,
			truncated: false,
			extraGaps: ["额外缺陷1", "额外缺陷2"],
		});
		expect(got.gaps?.length).toBe(4); // extraGaps(2) + unmatched(1) + verdict.gap(1)
		expect(got.gaps).toContain("额外缺陷1");
		expect(got.gaps).toContain("额外缺陷2");
		expect(got.gaps?.join("\n")).toContain("C-9");
		expect(got.gaps?.join("\n")).toContain("缺了条件");
	});

	// 补充覆盖:三个 reason 值都出现
	it("三种 reason 值都能出现在 gaps 里:source_law_unresolved", () => {
		const got = buildCoverageResult({
			alignment: alignment([], ["C-1"], { "C-1": "source_law_unresolved" }),
			verdicts: [],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.gaps?.join("\n")).toContain("source_law_unresolved");
	});

	it("三种 reason 值都能出现在 gaps 里:uploaded_document_has_no_clauses", () => {
		const got = buildCoverageResult({
			alignment: alignment([], ["C-2"], { "C-2": "uploaded_document_has_no_clauses" }),
			verdicts: [],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.gaps?.join("\n")).toContain("uploaded_document_has_no_clauses");
	});

	// 补充覆盖:truncated 且 unmatched 并发
	it("truncated 且 unmatched 并发时,两类 gap 都在", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1)], ["C-9"]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺A" }],
			checkedCount: 3,
			truncated: true,
		});
		// gaps: unmatched(1) + 漏判的对(1) + verdict.gap(1) + truncated(1) = 4
		expect(got.gaps?.length).toBe(4);
		expect(got.gaps?.join("\n")).toContain("C-9");
		expect(got.gaps?.join("\n")).toContain("缺A");
		expect(got.gaps?.join("\n")).toContain("截断");
	});

	// 补充覆盖:metrics 在三者并发下恒成立
	it("metrics 四项之和恒等于 checked:truncated + unmatched + mixed verdicts", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1), pair(2), pair(3)], ["C-9", "C-10"]),
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				{ pairIndex: 1, state: "missing", gap: "a" },
				{ pairIndex: 2, state: "conflict", conflictType: "x", gap: "b" },
				// pairIndex 3 漏判
			],
			checkedCount: 6,
			truncated: true,
		});
		const m = got.metrics;
		// 验证:
		// - alignment.unmatched.length = 2
		// - 漏判的对 = 1
		// - covered = 1
		// - missing = 1
		// - conflict = 1
		// 总计:2 + 1 + 1 + 1 + 1 = 6
		expect(m.unmatched).toBe(3); // 2 from unmatched + 1 from missing verdict
		expect(m.covered).toBe(1);
		expect(m.missing).toBe(1);
		expect(m.conflict).toBe(1);
		expect(m.missing + m.conflict + m.covered + m.unmatched).toBe(m.checked);
		expect(m.checked).toBe(6);
	});

	// 补充覆盖:basis 字段来自原始数据(包括可为 null 的字段)
	it("basis.externalDocNo 来自 internalObligation.docNo", () => {
		const docNo = "某特定规号";
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: "条1",
						docTitle: "规章",
						docNo,
						deonticType: "obligation",
						evidence: "应",
						text: "文",
						sourceCode: "SC",
					},
				}),
			]),
			verdicts: [{ pairIndex: 0, state: "missing" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].basis.externalDocNo).toBe(docNo);
	});

	it("basis.internalSourceCode 来自 sourceCode,可为 null", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: "条1",
						docTitle: "规章",
						docNo: "规号",
						deonticType: "obligation",
						evidence: "应",
						text: "文",
						sourceCode: null,
					},
				}),
			]),
			verdicts: [{ pairIndex: 0, state: "missing" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].basis.internalSourceCode).toBeNull();
	});

	// 补充覆盖:index 的正确性和连续性(多行情况)
	it("多行时 index 正确递增", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1), pair(2), pair(3), pair(4)]),
			verdicts: [
				{ pairIndex: 0, state: "missing" },
				{ pairIndex: 1, state: "covered" }, // 不进 rows
				{ pairIndex: 2, state: "conflict", conflictType: "x" },
				{ pairIndex: 3, state: "partial" },
				{ pairIndex: 4, state: "missing" },
			],
			checkedCount: 5,
			truncated: false,
		});
		expect(got.rows.map((r) => r.index)).toEqual([1, 2, 3, 4]);
		expect(got.rows).toHaveLength(4);
	});

	// 补充覆盖:missing 归 tabKey="missing"
	it("missing 状态归 tabKey=missing", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "missing", gap: "缺某项" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].tabKey).toBe("missing");
		expect(got.metrics.missing).toBe(1);
	});

	// 补充覆盖:模型漏判多条对的情况
	it("多条对都漏判时都计入 unmatched", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0), pair(1), pair(2), pair(3)]),
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				{ pairIndex: 2, state: "missing" },
				// pairIndex 1, 3 漏判
			],
			checkedCount: 4,
			truncated: false,
		});
		expect(got.metrics.unmatched).toBe(2);
		expect(got.gaps?.filter((g) => g.includes("未获模型判定")).length).toBe(2);
	});
});
