import type { ExternalClause } from "./types.ts";

/**
 * 与 audit-ai `config/obligation.yaml` 对齐的外规义务条款预过滤。
 *
 * 覆盖比对只核查需要被落实的规范性要求；说明性、定义性条款不进入后续的
 * 内规语义检索。该过滤发生在 Pi 侧，因而上传外规和知识库外规走同一规则。
 */
const NON_BARE_OBLIGATION_MARKERS = ["必须", "不得", "禁止", "严禁", "不应", "不准", "有义务", "负有", "责令"] as const;

const BARE_MARKERS = ["应", "须"] as const;

/** `应`、`须` 前面的一个字与它组成以下词时，不表示规范性义务。 */
const BARE_MARKER_EXCLUSIONS = new Set([
	"相应",
	"适应",
	"对应",
	"响应",
	"反应",
	"供应",
	"答应",
	"顺应",
	"效应",
	"感应",
	"呼应",
	"映应",
	"无须",
	"毋须",
]);

function hasAllowedBareMarker(text: string, marker: (typeof BARE_MARKERS)[number]): boolean {
	for (let offset = text.indexOf(marker); offset >= 0; offset = text.indexOf(marker, offset + marker.length)) {
		const prefix = offset > 0 ? `${text[offset - 1]}${marker}` : marker;
		if (!BARE_MARKER_EXCLUSIONS.has(prefix)) return true;
	}
	return false;
}

export function isObligationClause(text: string): boolean {
	return (
		NON_BARE_OBLIGATION_MARKERS.some((marker) => text.includes(marker)) ||
		BARE_MARKERS.some((marker) => hasAllowedBareMarker(text, marker))
	);
}

export function filterExternalObligationClauses(clauses: readonly ExternalClause[]): ExternalClause[] {
	return clauses.filter((clause) => isObligationClause(clause.text));
}

/** @deprecated 使用 `isObligationClause`，内规/外规采用同一义务词口径。 */
export const isExternalObligationClause = isObligationClause;
