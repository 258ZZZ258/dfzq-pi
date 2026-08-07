import type { AlignmentResult, CoverageResult, CoverageRow, Verdict } from "./types.ts";

export interface BuildInput {
	alignment: AlignmentResult;
	verdicts: readonly Verdict[];
	/** 实际处理的内规条款数(= 阶段 2 `items.length`)。metrics 四项之和恒等于此。
	 *  阶段 2 被 limit 截断时会小于库内真实总数,该数字用 `libraryTotal` 传入。*/
	checkedCount: number;
	/** 阶段 2 是否撞到 limit 被截断。 */
	truncated: boolean;
	/** 调用方额外要报的 gap(如 M2 的 rejected/unresolved 明细)。 */
	extraGaps?: readonly string[];
	/** 上传外规的发文字号(`ExternalDocument.docNo`)。上传件解析目前拿不到,恒 undefined ——
	 *  仍然显式传进来,好过把内规的字号冒充成外规的。 */
	externalDocNo?: string | null;
	/** 库内真实总条数。仅在 `truncated=true` 时用于 gaps 文案。 */
	libraryTotal?: number;
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
 *
 * ⚠ metrics 按**内规条款**计,一条内规只算一次(即使由 doc_level 扇成多个 pair)。
 * 取其全部 pair 的判定中最严重的一档(conflict > missing/partial > covered > unmatched)。
 */
export function buildCoverageResult(input: BuildInput): CoverageResult {
	const { alignment, verdicts, checkedCount, truncated, externalDocNo, libraryTotal } = input;
	const byIndex = new Map(verdicts.map((v) => [v.pairIndex, v]));

	const rows: CoverageRow[] = [];
	const gaps: string[] = [...(input.extraGaps ?? [])];

	// 🔴 全军覆没:一对都没对上,而全部内规都进了 unmatched。这时输出是一张空表 + N 条一模一样的
	// `external_clause_not_in_uploaded_document`,读起来像「内规全都没接住外规」,实则多半是**对齐
	// 本身失效**了 —— 见 align.ts 的说明:doc_no 侧今天恒缺失,对齐实际只剩「标题归一相等」一条腿,
	// 上传件标题与达梦 doc_title 差一个「(2026年修订)」或一对书名号就会整体落空。
	// 用 `unshift` 顶到 gaps 最前面 —— 包括顶到上面已经塞进 `gaps` 的 `extraGaps`(M2 的
	// rejected/unresolved、C1 的越界判定明细)前面:这条诊断的是「对齐本身可能已经失效」这种更根源性
	// 的问题,理应比任何逐条明细更早被看到。N 条明细仍然保留(不静默丢,审计人员要能顺着 chunk_id
	// 回查)。
	if (alignment.pairs.length === 0 && checkedCount > 0 && alignment.unmatched.length === checkedCount) {
		gaps.unshift(
			`🔴 全部 ${checkedCount} 条内规义务条款都没能对齐到上传外规,零条款对进入判定 —— ` +
				"这更像对齐失效而不是「内规全都没接住」:阶段 4 今天只有「上传件标题归一后逐字等于映射侧 doc_title」" +
				"这一条可用判据,请先核对两侧文档标题是否一致,再看下面逐条明细。",
		);
	}

	// 记录对齐失败的内规
	for (const item of alignment.unmatched) {
		gaps.push(`内规条款 ${item.internalChunkId} 未对齐到上传外规:${item.reason}`);
	}

	// 按 chunkId 分组 pairs,计算每条内规最严重的判定等级
	const byChunkId = new Map<string, { pairs: typeof alignment.pairs; verdicts: Array<Verdict | undefined> }>();
	alignment.pairs.forEach((pair, i) => {
		const chunkId = pair.internalObligation.chunkId;
		if (!byChunkId.has(chunkId)) {
			byChunkId.set(chunkId, { pairs: [], verdicts: [] });
		}
		const group = byChunkId.get(chunkId)!;
		group.pairs.push(pair);
		group.verdicts.push(byIndex.get(i));
	});

	// 计算 metrics:每条内规一次
	let covered = 0;
	let missing = 0;
	let conflict = 0;
	let unmatched = alignment.unmatched.length;

	for (const { verdicts: pairVerdicts } of byChunkId.values()) {
		// 取最严重的等级:conflict > missing/partial > covered > unmatched
		let hasConflict = false;
		let hasMissingOrPartial = false;
		let hasCovered = false;
		let hasUnmatched = false;

		for (const verdict of pairVerdicts) {
			if (!verdict) {
				// 这个 pair 没有判定
				hasUnmatched = true;
			} else if (verdict.state === "conflict") {
				hasConflict = true;
			} else if (verdict.state === "partial" || verdict.state === "missing") {
				hasMissingOrPartial = true;
			} else if (verdict.state === "covered") {
				hasCovered = true;
			}
		}

		if (hasConflict) {
			conflict += 1;
		} else if (hasMissingOrPartial) {
			missing += 1;
		} else if (hasCovered) {
			covered += 1;
		} else if (hasUnmatched) {
			// 全部 pair 都没判定
			unmatched += 1;
		}
	}

	// 构造 rows:仍然按 pair 出,index 连续
	alignment.pairs.forEach((pair, i) => {
		const verdict = byIndex.get(i);
		// 漏判的 pair 不进 rows,但要写 gaps
		if (!verdict) {
			gaps.push(`内规条款 ${pair.internalObligation.chunkId} 未获模型判定(pairIndex=${i})`);
			return;
		}
		if (verdict.state === "covered") {
			return;
		}

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
				externalDocNo: externalDocNo ?? null,
				matchKind: pair.matchKind,
			},
		});
		if (verdict.gap) gaps.push(`${pair.internalObligation.chunkId}:${verdict.gap}`);
	});

	if (truncated) {
		const total = libraryTotal ?? checkedCount;
		gaps.push(`内规义务条款超过上限被截断,实际核查 ${alignment.pairs.length} 对、库内共 ${total} 条`);
	}

	return {
		compareType: "external_to_internal",
		// `linked` 恒 0、`linkedDetail` 不产出,是**本轮刻意不做**,不是漏了(规格 §6.1 / §11)。
		// schema 里留着这两个位是为了对齐 `Java对接协议` §9.3 的 `LinkedDetailPayload`,但本规格
		// 从未定义谁来填它们 —— 前端的「关联明细」面板本轮因此恒空。要填,得先定「关联」的口径
		// (关联到审计规则?检查点?),那是另一轮的事。
		metrics: { checked: checkedCount, missing, conflict, covered, unmatched, linked: 0 },
		rows,
		gaps,
		finish_reason: "stop",
	};
}
