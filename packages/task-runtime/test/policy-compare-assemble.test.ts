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

	// 补充覆盖:metrics 按内规条款计数,不按 pair 计数(doc_level 扇出下守恒)
	// 这是关键测试:doc_level 会把一条内规扇出多个 pair,metrics 仍按内规计
	it("doc_level 扇出下守恒:1 条内规 × 3 个外规条款 = 3 个 pair,metrics 按内规计", () => {
		// 构造: 1 条内规(C-0),扇出到 3 个外规条款,都判 covered
		const externalClauses = [
			{ seq: 0, clausePath: "第1条", text: "外规第1条" },
			{ seq: 1, clausePath: "第2条", text: "外规第2条" },
			{ seq: 2, clausePath: "第3条", text: "外规第3条" },
		];
		const internalObligation = {
			chunkId: "C-0",
			clausePath: "条1",
			docTitle: "内规",
			docNo: "内〔2026〕1号",
			deonticType: "obligation" as const,
			evidence: "应当",
			text: "内规第1条",
			sourceCode: "SC-0",
		};

		const got = buildCoverageResult({
			alignment: {
				pairs: externalClauses.map((ec) => ({
					externalClause: ec,
					internalObligation,
					matchKind: "doc_level" as const,
				})),
				unmatched: [],
			},
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				{ pairIndex: 1, state: "covered" },
				{ pairIndex: 2, state: "covered" },
			],
			checkedCount: 1,
			truncated: false,
		});
		// metrics 按内规计:只有 1 条内规,全部 pair 都 covered
		expect(got.metrics.covered).toBe(1);
		expect(got.metrics.missing).toBe(0);
		expect(got.metrics.conflict).toBe(0);
		expect(got.metrics.unmatched).toBe(0);
		expect(got.metrics.missing + got.metrics.conflict + got.metrics.covered + got.metrics.unmatched).toBe(
			got.metrics.checked,
		);
		// rows 仍按 pair 出,但都是 covered 所以 rows 为空
		expect(got.rows).toHaveLength(0);
	});

	// 补充覆盖:basis 字段来自原始数据(包括可为 null 的字段)
	it("basis.externalDocNo 来自 BuildInput.externalDocNo", () => {
		const externalDocNo = "外规〔2026〕1号";
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "missing" }],
			checkedCount: 1,
			truncated: false,
			externalDocNo,
		});
		expect(got.rows[0].basis.externalDocNo).toBe(externalDocNo);
	});

	it("basis.externalDocNo 不传时为 null", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "missing" }],
			checkedCount: 1,
			truncated: false,
		});
		expect(got.rows[0].basis.externalDocNo).toBeNull();
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

	// 评审要求的新测试 2:最严重档取胜
	it("最严重档取胜:1 条内规 3 个 pair 分别判 covered/missing/conflict → 只计入 conflict", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: "条1",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文1",
						sourceCode: "SC-0",
					},
				}),
				pair(1, {
					internalObligation: {
						chunkId: "C-0", // 同一条内规
						clausePath: "条2",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文2",
						sourceCode: "SC-0",
					},
				}),
				pair(2, {
					internalObligation: {
						chunkId: "C-0", // 同一条内规
						clausePath: "条3",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文3",
						sourceCode: "SC-0",
					},
				}),
			]),
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				{ pairIndex: 1, state: "missing", gap: "缺A" },
				{ pairIndex: 2, state: "conflict", conflictType: "冲突", gap: "冲突B" },
			],
			checkedCount: 1,
			truncated: false,
		});
		// 最严重档是 conflict
		expect(got.metrics.conflict).toBe(1);
		expect(got.metrics.missing).toBe(0);
		expect(got.metrics.covered).toBe(0);
		// rows 仍然按 pair 出:missing 和 conflict 的各一行
		expect(got.rows).toHaveLength(2);
		expect(got.rows.map((r) => r.tabKey)).toEqual(["missing", "error"]);
	});

	// 评审要求的新测试 3:部分漏判
	it("部分漏判:1 条内规 2 个 pair,一个判 covered、一个无判定 → 计入 covered,但 gaps 有漏判", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: "条1",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文1",
						sourceCode: "SC-0",
					},
				}),
				pair(1, {
					internalObligation: {
						chunkId: "C-0", // 同一条内规
						clausePath: "条2",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文2",
						sourceCode: "SC-0",
					},
				}),
			]),
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				// pairIndex 1 无判定
			],
			checkedCount: 1,
			truncated: false,
		});
		// 该内规有部分 pair 无判定,但其他 pair 已判 covered,所以整个内规归 covered
		expect(got.metrics.covered).toBe(1);
		expect(got.metrics.unmatched).toBe(0); // 不因为有漏判就计入 unmatched
		// 漏判的 pair 写进 gaps
		expect(got.gaps?.join("\n")).toContain("未获模型判定(pairIndex=1)");
		// rows 空(因为只有 covered 和漏判,都不进 rows)
		expect(got.rows).toHaveLength(0);
	});

	// 评审要求的新测试 4:全部漏判
	it("全部漏判:1 条内规 2 个 pair 都无判定 → 计入 unmatched **一次**", () => {
		const got = buildCoverageResult({
			alignment: alignment([
				pair(0, {
					internalObligation: {
						chunkId: "C-0",
						clausePath: "条1",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文1",
						sourceCode: "SC-0",
					},
				}),
				pair(1, {
					internalObligation: {
						chunkId: "C-0", // 同一条内规
						clausePath: "条2",
						docTitle: "内规",
						docNo: "内号",
						deonticType: "obligation",
						evidence: "应",
						text: "文2",
						sourceCode: "SC-0",
					},
				}),
			]),
			verdicts: [],
			checkedCount: 1,
			truncated: false,
		});
		// 该内规全部 pair 都无判定,计入 unmatched **一次**
		expect(got.metrics.unmatched).toBe(1);
		expect(got.metrics.covered).toBe(0);
		expect(got.metrics.missing).toBe(0);
		// 两条漏判都写进 gaps
		expect(got.gaps?.filter((g) => g.includes("未获模型判定")).length).toBe(2);
	});

	// 评审要求的新测试 5:truncated 用 libraryTotal
	it("truncated 用 libraryTotal:checkedCount=500、libraryTotal=1200", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)]),
			verdicts: [{ pairIndex: 0, state: "covered" }],
			checkedCount: 500,
			truncated: true,
			libraryTotal: 1200,
		});
		const msg = got.gaps?.join("\n") || "";
		// 文案应该包含 pairs.length 和 libraryTotal
		expect(msg).toContain("1");
		expect(msg).toContain("1200");
		// metrics 仍按 checkedCount 算
		expect(got.metrics.checked).toBe(500);
	});

	// 评审要求的新测试 6:改成有判别力的守恒测试
	it("metrics 守恒:checkedCount 独立于 pairs/unmatched 的算术", () => {
		// 构造:让 checkedCount、pairs 数量、unmatched 数量都不同,验证守恒仍成立
		// 4 个内规:C-0(covered)、C-1(missing)、C-2(conflict)、C-3(未对齐)
		// 但 pair 不一定各 1 个 —— C-0 扇出 3 个 pair
		const got = buildCoverageResult({
			alignment: {
				pairs: [
					// C-0 扇出 3 个 pair,都 covered
					{
						externalClause: { seq: 0, clausePath: "E1", text: "E1" },
						internalObligation: {
							chunkId: "C-0",
							clausePath: "I1",
							docTitle: "D",
							docNo: "N",
							deonticType: "obligation",
							evidence: "E",
							text: "T",
							sourceCode: "S",
						},
						matchKind: "doc_level" as const,
					},
					{
						externalClause: { seq: 1, clausePath: "E2", text: "E2" },
						internalObligation: {
							chunkId: "C-0",
							clausePath: "I2",
							docTitle: "D",
							docNo: "N",
							deonticType: "obligation",
							evidence: "E",
							text: "T",
							sourceCode: "S",
						},
						matchKind: "doc_level" as const,
					},
					{
						externalClause: { seq: 2, clausePath: "E3", text: "E3" },
						internalObligation: {
							chunkId: "C-0",
							clausePath: "I3",
							docTitle: "D",
							docNo: "N",
							deonticType: "obligation",
							evidence: "E",
							text: "T",
							sourceCode: "S",
						},
						matchKind: "doc_level" as const,
					},
					// C-1 一个 pair,missing
					{
						externalClause: { seq: 3, clausePath: "E4", text: "E4" },
						internalObligation: {
							chunkId: "C-1",
							clausePath: "I4",
							docTitle: "D",
							docNo: "N",
							deonticType: "obligation",
							evidence: "E",
							text: "T",
							sourceCode: "S",
						},
						matchKind: "exact" as const,
					},
					// C-2 一个 pair,conflict
					{
						externalClause: { seq: 4, clausePath: "E5", text: "E5" },
						internalObligation: {
							chunkId: "C-2",
							clausePath: "I5",
							docTitle: "D",
							docNo: "N",
							deonticType: "obligation",
							evidence: "E",
							text: "T",
							sourceCode: "S",
						},
						matchKind: "exact" as const,
					},
				],
				unmatched: [{ internalChunkId: "C-3", reason: "source_law_unresolved" }],
			},
			verdicts: [
				{ pairIndex: 0, state: "covered" },
				{ pairIndex: 1, state: "covered" },
				{ pairIndex: 2, state: "covered" },
				{ pairIndex: 3, state: "missing", gap: "缺" },
				{ pairIndex: 4, state: "conflict", conflictType: "x", gap: "冲" },
			],
			checkedCount: 4,
			truncated: false,
		});

		const m = got.metrics;
		// 4 条内规:covered(1) + missing(1) + conflict(1) + unmatched(1) = 4
		expect(m.covered).toBe(1);
		expect(m.missing).toBe(1);
		expect(m.conflict).toBe(1);
		expect(m.unmatched).toBe(1);
		// 守恒:内规数自洽
		expect(m.missing + m.conflict + m.covered + m.unmatched).toBe(m.checked);
		expect(m.checked).toBe(4);
		// rows 按 pair 出:2 条非 covered 的 pair(missing + conflict)
		expect(got.rows).toHaveLength(2);
	});
});

/**
 * 终审 I7:`align.ts` 的对齐今天只剩「上传件标题归一后逐字等于映射侧 doc_title」一条腿
 * (`doc.docNo` 恒 `undefined` ⇒ 规格 §3.3 第 1 级与 `matchKind: "exact"` 不可达)。
 * 标题差一个「(2026年修订)」就会全军覆没,而输出是一张空表 + N 条一模一样的
 * `external_clause_not_in_uploaded_document` —— 读起来像「内规全都没接住外规」。
 */
describe("buildCoverageResult · 全军覆没的醒目 gap(终审 I7)", () => {
	it("零 pair 且 unmatched == checked → 单独报一条,排在 gaps 最前面", () => {
		const got = buildCoverageResult({
			alignment: alignment([], ["C-0", "C-1", "C-2"]),
			verdicts: [],
			checkedCount: 3,
			truncated: false,
		});
		expect(got.gaps?.[0]).toContain("都没能对齐到上传外规");
		// 要点明「先去核对标题」——这才是它比 N 条明细多出来的那点信息量
		expect(got.gaps?.[0]).toContain("标题");
	});

	it("N 条逐条明细仍然保留(不静默丢:审计人员要能顺着 chunk_id 回查)", () => {
		const got = buildCoverageResult({
			alignment: alignment([], ["C-0", "C-1", "C-2"]),
			verdicts: [],
			checkedCount: 3,
			truncated: false,
		});
		for (const id of ["C-0", "C-1", "C-2"]) {
			expect(got.gaps?.join("\n")).toContain(`内规条款 ${id} 未对齐到上传外规`);
		}
	});

	it("只是部分没对上 → 不报这条(否则它会变成一条恒真的噪音)", () => {
		const got = buildCoverageResult({
			alignment: alignment([pair(0)], ["C-9"]),
			verdicts: [{ pairIndex: 0, state: "covered" }],
			checkedCount: 2,
			truncated: false,
		});
		expect(got.gaps?.some((g) => g.includes("都没能对齐到上传外规"))).toBe(false);
	});

	it("阶段 2 一条义务都没圈到(checked=0)→ 也不报这条(那不是对齐失效)", () => {
		const got = buildCoverageResult({
			alignment: alignment([]),
			verdicts: [],
			checkedCount: 0,
			truncated: false,
		});
		expect(got.gaps?.some((g) => g.includes("都没能对齐到上传外规"))).toBe(false);
	});

	// 复审发现:`gaps` 用 `[...extraGaps]` 初始化,这条醒目 gap 此前是 `push` 进去的 —— extraGaps
	// 非空时(M2 的 rejected/unresolved、C1 的越界判定明细)它恒排在醒目 gap 前面,与注释「排在最
	// 前面」不符。改成 `unshift` 后补这条测试锁住顺序:extraGaps 非空也不能盖过它。
	it("extraGaps 非空时,醒目 gap 仍然顶到 gaps[0](unshift,不被 extraGaps 盖过)", () => {
		const got = buildCoverageResult({
			alignment: alignment([], ["C-0", "C-1", "C-2"]),
			verdicts: [],
			checkedCount: 3,
			truncated: false,
			extraGaps: ["resolve_source_law 拒绝了本 run 结果集外的 chunk_id:C-9"],
		});
		expect(got.gaps?.[0]).toContain("都没能对齐到上传外规");
		// extraGaps 没有被顶掉,仍然在数组里(只是不再是第一条)
		expect(got.gaps?.join("\n")).toContain("C-9");
	});
});
