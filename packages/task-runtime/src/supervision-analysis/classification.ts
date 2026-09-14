import { readFileSync } from "node:fs";

const categories: Record<string, string[]> = JSON.parse(
	readFileSync(new URL("../../specs/supervision-analysis/categories.json", import.meta.url), "utf8"),
);
/** Ambiguous or absent evidence stays unclassified; no default low-risk conclusion. */
export function classifyIssue(text: string, allowed: readonly string[]): string {
	const matches = Object.entries(categories).filter(
		([category, words]) => allowed.includes(category) && words.some((word) => text.includes(word)),
	);
	return matches.length === 1 ? matches[0]![0] : "未分类";
}
