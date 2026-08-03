/** `search_policy` 返回的一条命中。除 `clause_id` 外的字段原样透传给模型。 */
export interface RetrievalHit {
	clause_id: string;
	[key: string]: unknown;
}

/**
 * 把多次检索的命中合并成一份，**按各自返回序轮询交错**，遇重复 clause_id 跳过。
 *
 * 🔴 **刻意不按 `score` 排序。** `rerank_backend = "none"` 时 audit-ai 的 `_display_score`
 * (`structured.py:33-39`) 回的是 **RRF 融合分**,只有**同一次查询内**的相对序、无绝对含义
 * (J4 真 run 实测四个分是 0.0322 / 0.0325 / 0.0307 / 0.0305)。跨查询按它排序 = 按噪声排序。
 * `score` 仍原样留在 hit 上给模型抄进 `basis[].score`,只是不参与本层排序。
 *
 * 调用方把「原始 query 抢跑那次」的结果放在 `lists[0]`。
 */
export function mergeHitsRoundRobin(lists: readonly (readonly RetrievalHit[])[], limit: number): RetrievalHit[] {
	if (limit <= 0) return [];
	const out: RetrievalHit[] = [];
	const seen = new Set<string>();
	const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
	for (let rank = 0; rank < longest; rank++) {
		for (const list of lists) {
			const hit = list[rank];
			if (hit === undefined || seen.has(hit.clause_id)) continue;
			seen.add(hit.clause_id);
			out.push(hit);
			if (out.length >= limit) return out;
		}
	}
	return out;
}
