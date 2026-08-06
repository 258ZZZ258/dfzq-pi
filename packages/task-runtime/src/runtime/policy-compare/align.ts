import type {
	AlignmentResult,
	ClausePair,
	ExternalClause,
	ExternalDocument,
	InternalObligation,
	SourceLawResolution,
	UnmatchedObligation,
} from "./types.ts";

/** 中文数字 → 阿拉伯数字。只覆盖条款号会出现的量级(万以内),口径与 audit-ai 的
 *  `pipeline/chunking/normalize.cn_to_int` 一致 —— 两侧算出的键必须逐位相同,否则
 *  `normalized` 这一级恒不命中。 */
const CN_DIGITS: Record<string, number> = {
	零: 0,
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function cnToInt(raw: string): number | null {
	let total = 0;
	let section = 0;
	let seenDigit = false;
	for (const ch of raw) {
		if (ch in CN_DIGITS) {
			section = CN_DIGITS[ch];
			seenDigit = true;
			continue;
		}
		const unit = CN_UNITS[ch];
		if (unit === undefined) return null;
		// 「十条」= 10:单位前没有数字时,系数按 1 算
		total += (section === 0 && !seenDigit ? 1 : section) * unit;
		section = 0;
		seenDigit = false;
	}
	return total + section;
}

/** 把一段中文数字串就地换成阿拉伯数字。非中文数字的片段原样保留。 */
function replaceCnNumbers(raw: string): string {
	return raw.replace(/[零一二三四五六七八九十百千]+/g, (run) => {
		const n = cnToInt(run);
		return n === null ? run : String(n);
	});
}

/**
 * 条款定位键的归一形式。全角→半角、去全部空白、中文数字→阿拉伯数字。
 *
 * ⚠ 这是 `normalized` 这一级唯一的判等依据。**不做任何模糊/相似度匹配** ——
 * 匹配错一条就等于把两条无关条款送去判覆盖(规格 §3.3)。
 */
export function normalizeClauseKey(raw: string | null | undefined): string {
	if (!raw) return "";
	// 全角 ASCII(U+FF01–U+FF5E)→ 半角;全角空格(U+3000)→ 普通空格
	const halfWidth = raw
		.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
		.replace(/　/g, " ");
	return replaceCnNumbers(halfWidth).replace(/\s+/g, "");
}

function pairOf(
	externalClause: ExternalClause,
	internalObligation: InternalObligation,
	matchKind: ClausePair["matchKind"],
): ClausePair {
	return { externalClause, internalObligation, matchKind };
}

/**
 * 阶段 4。规格 §3.3 的三级优先:
 *   1. (doc_no, clause_path) 精确相等          → exact
 *   2. (doc_title 归一, clause_path 归一) 相等 → normalized
 *   3. clause_path 为 null 但文档对得上         → doc_level(与该文档全部条款成对)
 *   都不中 → unmatched
 *
 * 一条内规可能衍生自多条外规,取**第一条对得上的**;全都对不上才判 unmatched。
 */
export function alignClauses(
	doc: ExternalDocument,
	obligations: readonly InternalObligation[],
	resolutions: readonly SourceLawResolution[],
): AlignmentResult {
	const byChunkId = new Map(resolutions.map((r) => [r.chunkId, r.sourceLaws]));
	const docNoKey = normalizeClauseKey(doc.docNo);
	const docTitleKey = normalizeClauseKey(doc.title);
	const byPath = new Map(doc.clauses.map((c) => [normalizeClauseKey(c.clausePath), c]));

	const pairs: ClausePair[] = [];
	const unmatched: UnmatchedObligation[] = [];

	for (const ob of obligations) {
		const sourceLaws = byChunkId.get(ob.chunkId);
		// M2 压根没回这条 —— 与「回了但对不上」是两件事,reason 分开(规格 §3.3 不静默丢)
		if (sourceLaws === undefined || sourceLaws.length === 0) {
			unmatched.push({ internalChunkId: ob.chunkId, reason: "source_law_unresolved" });
			continue;
		}

		let matchedThis = false;
		for (const ref of sourceLaws) {
			const refDocNo = normalizeClauseKey(ref.docNo);
			const refTitle = normalizeClauseKey(ref.docTitle);
			const sameDoc = (refDocNo !== "" && refDocNo === docNoKey) || (refTitle !== "" && refTitle === docTitleKey);
			if (!sameDoc) continue;

			// 粒度是文档级:映射只说到「衍生自这部外规」,与该文档全部条款成对
			if (ref.clausePath === null || ref.clausePath === "") {
				for (const clause of doc.clauses) pairs.push(pairOf(clause, ob, "doc_level"));
				matchedThis = true;
				break;
			}

			const clause = byPath.get(normalizeClauseKey(ref.clausePath));
			if (!clause) continue;
			// 两级只差在「文档靠什么对上」,条款一律走归一键查表 —— 精确相等的那条
			// 归一后必然也相等,所以这里只需按文档的匹配方式给 matchKind 定级。
			const exactDoc = refDocNo !== "" && ref.docNo === doc.docNo && ref.clausePath === clause.clausePath;
			pairs.push(pairOf(clause, ob, exactDoc ? "exact" : "normalized"));
			matchedThis = true;
			break;
		}

		if (!matchedThis) {
			unmatched.push({ internalChunkId: ob.chunkId, reason: "external_clause_not_in_uploaded_document" });
		}
	}

	return { pairs, unmatched };
}
