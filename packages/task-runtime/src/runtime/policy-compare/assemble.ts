import type { AlignmentResult, CoverageResult, CoverageRow, Verdict } from "./types.ts";

export interface BuildInput {
	alignment: AlignmentResult;
	verdicts: readonly Verdict[];
	/** 阶段 2 的 total(核查条款数)。**不是** pairs.length —— 对不上的也算核查过。 */
	checkedCount: number;
	/** 阶段 2 是否撞到 limit 被截断。 */
	truncated: boolean;
	/** 调用方额外要报的 gap(如 M2 的 rejected/unresolved 明细)。 */
	extraGaps?: readonly string[];
}

const JUDGEMENT_BY_STATE: Record<Exclude<Verdict["state"], "covered">, string> = {
	partial: "部分覆盖",
	missing: "缺失要求",
	conflict: "口径不一致",
};

/**
 * 阶段 6。四态 → `tabKey` 的映射见规格 §6.1:
 *   missing / partial → tabKey "missing";conflict → "error";covered **不进 rows**。
 *
 * 🔴 `externalClause` / `internalClause` 一律从 `alignment.pairs` 的原始数据取,
 * **不从 verdict 取** —— 模型不产正文(规格 §6.3-2),这是该约束在代码里的落点。
 */
export function buildCoverageResult(input: BuildInput): CoverageResult {
	const { alignment, verdicts, checkedCount, truncated } = input;
	const byIndex = new Map(verdicts.map((v) => [v.pairIndex, v]));

	const rows: CoverageRow[] = [];
	const gaps: string[] = [...(input.extraGaps ?? [])];
	let covered = 0;
	let missing = 0;
	let conflict = 0;
	// 对齐阶段就没对上的 + 模型漏判的,都归到 unmatched 这一档
	let unmatched = alignment.unmatched.length;

	for (const item of alignment.unmatched) {
		gaps.push(`内规条款 ${item.internalChunkId} 未对齐到上传外规:${item.reason}`);
	}

	alignment.pairs.forEach((pair, i) => {
		const verdict = byIndex.get(i);
		// 模型漏判 —— 计入 unmatched 并写 gaps,绝不当成「已覆盖」悄悄放过
		if (!verdict) {
			unmatched += 1;
			gaps.push(`内规条款 ${pair.internalObligation.chunkId} 未获模型判定(pairIndex=${i})`);
			return;
		}
		if (verdict.state === "covered") {
			covered += 1;
			return;
		}
		if (verdict.state === "conflict") conflict += 1;
		else missing += 1;

		rows.push({
			index: rows.length + 1,
			tabKey: verdict.state === "conflict" ? "error" : "missing",
			conflictType:
				verdict.state === "partial" ? "部分覆盖" : (verdict.conflictType ?? JUDGEMENT_BY_STATE[verdict.state]),
			externalClause: pair.externalClause.text,
			internalClause: pair.internalObligation.text,
			judgement: JUDGEMENT_BY_STATE[verdict.state],
			source: [pair.internalObligation.docTitle, pair.internalObligation.clausePath].filter(Boolean).join(" "),
			suggestion: verdict.suggestion ?? "",
			basis: {
				internalChunkId: pair.internalObligation.chunkId,
				internalSourceCode: pair.internalObligation.sourceCode,
				externalClausePath: pair.externalClause.clausePath,
				externalDocNo: pair.internalObligation.docNo,
				matchKind: pair.matchKind,
			},
		});
		if (verdict.gap) gaps.push(`${pair.internalObligation.chunkId}:${verdict.gap}`);
	});

	if (truncated) {
		gaps.push(`内规义务条款超过上限被截断,实际核查 ${alignment.pairs.length} 对、库内共 ${checkedCount} 条`);
	}

	return {
		compareType: "external_to_internal",
		metrics: { checked: checkedCount, missing, conflict, covered, unmatched, linked: 0 },
		rows,
		gaps,
		finish_reason: "stop",
	};
}
