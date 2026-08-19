import type { AlignmentResult, CoverageResult, CoverageRow, Verdict } from "./types.ts";

export interface BuildInput {
	/** 覆盖核查方向。行表形状相同，但调用方/前端需据此解释核查对象。 */
	compareType?: CoverageResult["compareType"];
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
 * 阶段 6。外规→内规方向：missing / partial → "missing"，conflict → "error"。
 * 内规→外规方向：covered 不出表；partial / conflict → "error"；missing 与无候选 → "missing"。
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
	const countByExternal = alignment.countBy === "external";
	const isInternalToExternal = input.compareType === "internal_to_external";

	// 🔴 全军覆没:一对都没对上,而全部内规都进了 unmatched。这时输出是一张空表 + N 条一模一样的
	// `external_clause_not_in_uploaded_document`,读起来像「内规全都没接住外规」,实则多半是**对齐
	// 本身失效**了 —— 见 align.ts 的说明:doc_no 侧今天恒缺失,对齐实际只剩「标题归一相等」一条腿,
	// 上传件标题与达梦 doc_title 差一个「(2026年修订)」或一对书名号就会整体落空。
	// 用 `unshift` 顶到 gaps 最前面 —— 包括顶到上面已经塞进 `gaps` 的 `extraGaps`(M2 的
	// rejected/unresolved、C1 的越界判定明细)前面:这条诊断的是「对齐本身可能已经失效」这种更根源性
	// 的问题,理应比任何逐条明细更早被看到。N 条明细仍然保留(不静默丢,审计人员要能顺着 chunk_id
	// 回查)。
	if (!isInternalToExternal && alignment.pairs.length === 0 && checkedCount > 0 && alignment.unmatched.length === checkedCount) {
		gaps.unshift(
			`🔴 全部 ${checkedCount} 条内规义务条款都没能对齐到上传外规,零条款对进入判定 —— ` +
				"这更像对齐失效而不是「内规全都没接住」:阶段 4 今天只有「上传件标题归一后逐字等于映射侧 doc_title」" +
				"这一条可用判据,请先核对两侧文档标题是否一致,再看下面逐条明细。",
		);
	}

	// 记录对齐失败的内规
	for (const item of alignment.unmatched) {
		if (!isInternalToExternal) {
			gaps.push(`内规条款 ${item.internalChunkId} 未对齐到上传外规:${item.reason}`);
		}
	}

	// 映射路径按内规条款计数；批量检索路径按外规条款计数。
	// 后者同一外规可能有多个候选内规，只要其中一项被覆盖即可判该外规已覆盖。
	const byChunkId = new Map<
		string,
		{ pairs: typeof alignment.pairs; verdicts: Array<Verdict | undefined>; indexes: number[] }
	>();
	alignment.pairs.forEach((pair, i) => {
		const key = countByExternal
			? `${pair.externalClause.seq}\u0000${pair.externalClause.clausePath}\u0000${pair.externalClause.text}`
			: pair.internalObligation.chunkId;
	if (!byChunkId.has(key)) {
			byChunkId.set(key, { pairs: [], verdicts: [], indexes: [] });
		}
		const group = byChunkId.get(key)!;
		group.pairs.push(pair);
		group.verdicts.push(byIndex.get(i));
		group.indexes.push(i);
	});

	// 计算 metrics:每个核查主体一次。外规→内规按外规条款，内规→外规按内规条款。
	let covered = 0;
	let missing = 0;
	let conflict = 0;
	let unmatched = alignment.unmatched.length;
	const uncovered = alignment.uncoveredExternalClauses ?? [];
	if (countByExternal) missing += uncovered.length;

	for (const { verdicts: pairVerdicts } of byChunkId.values()) {
		// 内规→外规的“未覆盖”只表示未找到可用于反向核查的外规语义对象，
		// 不应被呈现为内部制度缺失；部分覆盖与冲突才是应展示的差错。
		let hasConflict = false;
		let hasMissing = false;
		let hasPartial = false;
		let hasCovered = false;
		let hasUnmatched = false;

		for (const verdict of pairVerdicts) {
			if (!verdict) {
				// 这个 pair 没有判定
				hasUnmatched = true;
			} else if (verdict.state === "conflict") {
				hasConflict = true;
			} else if (verdict.state === "partial") {
				hasPartial = true;
			} else if (verdict.state === "missing") {
				hasMissing = true;
			} else if (verdict.state === "covered") {
				hasCovered = true;
			}
		}

		if (hasConflict || (isInternalToExternal && hasPartial)) {
			conflict += 1;
		} else if (isInternalToExternal && hasCovered) {
			covered += 1;
		} else if (isInternalToExternal && hasMissing) {
			missing += 1;
		} else if (isInternalToExternal && hasUnmatched) {
			unmatched += 1;
		} else if (hasPartial || hasMissing) {
			missing += 1;
		} else if (hasCovered) {
			covered += 1;
		} else if (hasUnmatched) {
			// 全部 pair 都没判定
			unmatched += 1;
		}
	}

	// 批量检索会为一条外规找多条内部候选。若这些候选均被判为「缺失」,
	// 结论是该外规条款缺失，而非任一候选内规缺失：合并为一条空内部条款的结果，
	// 避免在界面上把检索候选误呈现为已关联的内部依据。
	const collapsedMissingRows = new Set<number>();
	const hiddenCandidateRows = new Set<number>();
	if (countByExternal) {
		for (const { verdicts: pairVerdicts, indexes } of byChunkId.values()) {
			if (pairVerdicts.length > 0 && pairVerdicts.every((verdict) => verdict?.state === "missing")) {
				collapsedMissingRows.add(indexes[0]);
				indexes.slice(1).forEach((index) => hiddenCandidateRows.add(index));
			}
		}
	}

	// 构造 rows:index 连续。普通映射路径仍按 pair 出；上述「全缺失」批量检索组按外规条款出一行。
	alignment.pairs.forEach((pair, i) => {
		if (hiddenCandidateRows.has(i)) return;
		const verdict = byIndex.get(i);
		// 漏判的 pair 不进 rows,但要写 gaps
		if (!verdict) {
			gaps.push(`内规条款 ${pair.internalObligation.chunkId} 未获模型判定(pairIndex=${i})`);
			return;
		}
		if (verdict.state === "covered") {
			return;
		}

		const hideInternalCandidate = collapsedMissingRows.has(i);
		rows.push({
			index: rows.length + 1,
			tabKey:
				verdict.state === "conflict" || (isInternalToExternal && verdict.state === "partial")
					? "error"
					: "missing",
			conflictType:
				verdict.state === "partial" ? "部分覆盖" : (verdict.conflictType ?? JUDGEMENT_BY_STATE[verdict.state]),
			externalClause: pair.externalClause.text,
			internalClause: hideInternalCandidate ? "" : pair.internalObligation.text,
			judgement: JUDGEMENT_BY_STATE[verdict.state],
			source: hideInternalCandidate
				? ""
				: [pair.internalObligation.docTitle, pair.internalObligation.clausePath].filter(Boolean).join(" "),
			suggestion: verdict.suggestion ?? "",
			basis: {
				internalChunkId: hideInternalCandidate ? "" : pair.internalObligation.chunkId,
				internalSourceCode: hideInternalCandidate ? null : pair.internalObligation.sourceCode,
				externalClausePath: pair.externalClause.clausePath,
				externalDocNo: externalDocNo ?? null,
				matchKind: pair.matchKind,
			},
		});
		if (verdict.gap) {
			gaps.push(
				hideInternalCandidate
					? `外规条款 ${pair.externalClause.clausePath}:${verdict.gap}`
					: `${pair.internalObligation.chunkId}:${verdict.gap}`,
			);
		}
	});

	for (const item of uncovered) {
		const retrievalFailed = item.reason === "retrieval_failed";
		rows.push({
			index: rows.length + 1,
			tabKey: "missing",
			conflictType: retrievalFailed ? "检索失败" : "未命中内部制度条款",
			externalClause: item.externalClause.text,
			internalClause: "",
			judgement: "缺失要求",
			source: "",
			suggestion: retrievalFailed ? "请重试检索后复核。" : "建议补充能够覆盖该外规要求的内部制度条款。",
			basis: {
				internalChunkId: "",
				internalSourceCode: null,
				externalClausePath: item.externalClause.clausePath,
				externalDocNo: externalDocNo ?? null,
				matchKind: "semantic_retrieval",
			},
		});
		gaps.push(`外规条款 ${item.externalClause.clausePath} ${item.reason}`);
	}

	// 内规→外规：外规候选为空/检索失败代表该内规条款无法证明覆盖外部规则，
	// 必须形成一条缺失点。外规侧留空，绝不把任意内规候选伪装成关联外规。
	for (const item of alignment.uncoveredInternalClauses ?? []) {
		const retrievalFailed = item.reason === "external_retrieval_failed";
		rows.push({
			index: rows.length + 1,
			tabKey: "missing",
			conflictType: retrievalFailed ? "外部规则检索失败" : "未命中外部规则条款",
			externalClause: "",
			internalClause: item.internalObligation.text,
			judgement: "缺失要求",
			source: [item.internalObligation.docTitle, item.internalObligation.clausePath].filter(Boolean).join(" "),
			suggestion: retrievalFailed
				? "请重试外部规则检索后复核。"
				: "建议核对该内规条款所依据的外部规则，并补充对应的外规依据或覆盖要求。",
			basis: {
				internalChunkId: item.internalObligation.chunkId,
				internalSourceCode: item.internalObligation.sourceCode,
				externalClausePath: null,
				externalDocNo: null,
				matchKind: "semantic_retrieval",
			},
		});
		missing += 1;
		unmatched -= 1;
		gaps.push(`内规条款 ${item.internalObligation.chunkId} ${item.reason}`);
	}

	if (truncated) {
		const total = libraryTotal ?? checkedCount;
		gaps.push(`内规义务条款超过上限被截断,实际核查 ${alignment.pairs.length} 对、库内共 ${total} 条`);
	}

	return {
		compareType: input.compareType ?? "external_to_internal",
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
