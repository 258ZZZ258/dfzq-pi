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
 *
 * 🔴 **今天第 1 级在真实链路上不可达,`matchKind: "exact"` 也不可达。** `doc.docNo` 由
 * `artifact-store.ts` 的 `parseArtifact` 填,而它恒填 `undefined`(上传件解析产物里没有发文
 * 字号这一项)⇒ 下面的 `docNoKey` 恒为空串 ⇒ `refDocNo !== "" && refDocNo === docNoKey` 恒假,
 * `exactDoc` 同理恒假。**文档一侧的对齐因此只剩「标题归一后逐字相等」这一条腿。**
 *
 * 这个脆弱点很实在:上传 PDF 解析出的标题多一个「(2026年修订)」、或映射侧标题带书名号,
 * 全部内规就会一条不落地进 `unmatched`,输出是一张空表 + 一堆 gaps。`assemble.ts` 对
 * 「零 pair 且 unmatched == checked」这种全军覆没单独报一条醒目的 gap,就是为了让这种失效
 * 不被读成「内规全都没接住外规」。要真正修它,得让上传件解析产出 `doc_no`(那在 audit-ai 侧)。
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
				// 文档对上了,但如果文档本身无条款,不能产生任何 pair —— 应进 unmatched
				if (doc.clauses.length === 0) {
					// 文档被识别但为空,这是第三种失败形态
					unmatched.push({ internalChunkId: ob.chunkId, reason: "uploaded_document_has_no_clauses" });
					matchedThis = true;
				} else {
					for (const clause of doc.clauses) pairs.push(pairOf(clause, ob, "doc_level"));
					matchedThis = true;
				}
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

/**
 * 外规→内规覆盖比对的批量检索对齐。
 *
 * 每条外规只能与它自己的检索候选成对：这与旧的「内规显式引用外规」映射完全不同。
 * 候选为空或该条检索失败都保留为显式缺失，由组装层生成可审计的结果行。
 */
export function alignBatchCandidates(
	doc: ExternalDocument,
	items: ReadonlyArray<{ queryIndex: number; candidates: readonly InternalObligation[]; error: string | null }>,
): AlignmentResult {
	const byIndex = new Map(items.map((item) => [item.queryIndex, item]));
	const pairs: ClausePair[] = [];
	const uncoveredExternalClauses: NonNullable<AlignmentResult["uncoveredExternalClauses"]> = [];

	for (const [index, externalClause] of doc.clauses.entries()) {
		const item = byIndex.get(index);
		if (!item || item.error || item.candidates.length === 0) {
			uncoveredExternalClauses.push({
				externalClause,
				reason: item?.error ? "retrieval_failed" : "no_internal_candidate",
			});
			continue;
		}
		for (const internalObligation of item.candidates) {
			pairs.push(pairOf(externalClause, internalObligation, "semantic_retrieval"));
		}
	}
	return { pairs, unmatched: [], uncoveredExternalClauses, countBy: "external" };
}

/**
 * 内规→外规覆盖比对的对称批量检索对齐。
 *
 * 这里的输入条款是待核查内规，MCP 返回的是语义相关的外规候选。它不读取也不假定
 * 「内规条款 → 外规条款」关系表；每个待核查内规条款与其检索得到的外规候选直接成对，
 * 后续仍由模型按同一覆盖判定契约判定。
 */
export function alignInternalToExternalBatchCandidates(
	internalClauses: readonly ExternalClause[],
	items: ReadonlyArray<{ queryIndex: number; candidates: readonly InternalObligation[]; error: string | null }>,
	internalTitle: string,
	internalDocNo?: string,
): AlignmentResult {
	const byIndex = new Map(items.map((item) => [item.queryIndex, item]));
	const pairs: ClausePair[] = [];
	const unmatched: UnmatchedObligation[] = [];
	const uncoveredInternalClauses: NonNullable<AlignmentResult["uncoveredInternalClauses"]> = [];

	for (const [index, internalClause] of internalClauses.entries()) {
		const item = byIndex.get(index);
		const sourceInternal: InternalObligation = {
			chunkId: `source-internal:${index}:${internalClause.seq}`,
			clausePath: internalClause.clausePath || null,
			docTitle: internalTitle,
			docNo: internalDocNo ?? null,
			deonticType: "obligation",
			evidence: null,
			text: internalClause.text,
			sourceCode: null,
		};
		if (!item || item.error || item.candidates.length === 0) {
			const reason = item?.error ? "external_retrieval_failed" : "no_external_candidate";
			unmatched.push({ internalChunkId: sourceInternal.chunkId, reason });
			uncoveredInternalClauses.push({ internalObligation: sourceInternal, reason });
			continue;
		}
		for (const candidate of item.candidates) {
			pairs.push(
				pairOf(
					{
						seq: index,
						clausePath: candidate.clausePath ?? "",
						text: candidate.text,
					},
					sourceInternal,
					"semantic_retrieval",
				),
			);
		}
	}
	// 一个待核查内规条款可能检索到多条外规候选，但结论必须归集回该内规条款。
	return { pairs, unmatched, uncoveredInternalClauses, countBy: "internal" };
}
