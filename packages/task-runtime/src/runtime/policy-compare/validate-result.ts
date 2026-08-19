import { Value } from "typebox/value";
import type { CoverageResult } from "./types.ts";

export interface ValidationContext {
	/** 阶段 2 结果集的全部 chunk_id。 */
	internalChunkIds: ReadonlySet<string>;
	/** 阶段 1 上传件解析出的全部条款正文。 */
	externalTexts: ReadonlySet<string>;
	/** 阶段 2 的全部条款正文。 */
	internalTexts: ReadonlySet<string>;
	/** 阶段 2 的实际处理条数。 */
	checkedCount: number;
}

export type ValidationOutcome = { ok: true } | { ok: false; detail: string };

/**
 * 规格 §6.3。schema 校验 + 四条反幻觉,**全部在代码侧**。
 *
 * 不复用 C6 的 `createOutputContractJudge`:它靠 `session.followUp()` 重问模型,而这里的
 * 输出由代码组装 —— 组装不出合规结果是代码 bug,重问模型无用。判负即 run 落 error。
 */
export function validateCoverageResult(
	result: CoverageResult,
	ctx: ValidationContext,
	schema: unknown,
): ValidationOutcome {
	// schema 校验
	if (!Value.Check(schema as never, result as never)) {
		const first = [...Value.Errors(schema as never, result as never)][0];
		return { ok: false, detail: first ? `${first.instancePath}: ${first.message}` : "schema 校验失败" };
	}

	// 反幻觉 1:引用必须来自阶段 2 的结果集
	const invented = result.rows
		.filter(
			(r) =>
				!(
					r.basis.matchKind === "semantic_retrieval" &&
					((r.basis.internalChunkId === "" && r.internalClause === "") ||
						(r.externalClause === "" && r.tabKey === "missing")) &&
					r.tabKey === "missing"
				),
		)
		.map((r) => r.basis.internalChunkId)
		.filter((id) => !ctx.internalChunkIds.has(id));
	if (invented.length > 0) {
		return { ok: false, detail: `basis.internalChunkId 不在阶段 2 结果集内:${invented.join("、")}` };
	}

	// 反幻觉 2:两侧正文必须逐字来自原始数据
	for (const [i, r] of result.rows.entries()) {
		const isNoCandidate = r.basis.matchKind === "semantic_retrieval" && r.basis.internalChunkId === "";
		const isNoExternalCandidate =
			r.basis.matchKind === "semantic_retrieval" && r.externalClause === "" && r.tabKey === "missing";
		if (!isNoExternalCandidate && !ctx.externalTexts.has(r.externalClause)) {
			return { ok: false, detail: `第 ${i + 1} 行的 externalClause 不是阶段 1 的原文(正文不得由模型产出)` };
		}
		if (isNoExternalCandidate) {
			if (!ctx.internalTexts.has(r.internalClause)) {
				return { ok: false, detail: `第 ${i + 1} 行的 internalClause 不是阶段 2 的原文(正文不得由模型产出)` };
			}
			continue;
		}
		if (isNoCandidate && r.externalClause === "") {
			return { ok: false, detail: `第 ${i + 1} 行的空外规条款必须保留内规原文` };
		}
		if (r.externalClause === "") {
			return { ok: false, detail: `第 ${i + 1} 行的 externalClause 不能为空` };
		}
		if (!isNoCandidate && !ctx.internalTexts.has(r.internalClause)) {
			return { ok: false, detail: `第 ${i + 1} 行的 internalClause 不是阶段 2 的原文(正文不得由模型产出)` };
		}
	}

	// 反幻觉 3:核查条款数必须与阶段 2 的实际处理条数一致
	if (result.metrics.checked !== ctx.checkedCount) {
		return {
			ok: false,
			detail: `metrics.checked=${result.metrics.checked} 与阶段 2 实际处理条数=${ctx.checkedCount} 不符`,
		};
	}

	// 反幻觉 4:四项之和自洽
	const m = result.metrics;
	const sum = m.missing + m.conflict + m.covered + m.unmatched;
	if (sum !== m.checked) {
		return { ok: false, detail: `metrics 不自洽:missing+conflict+covered+unmatched=${sum},checked=${m.checked}` };
	}

	return { ok: true };
}
