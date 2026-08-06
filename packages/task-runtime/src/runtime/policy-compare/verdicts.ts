import { extractJsonBlock } from "../output-contract.ts";
import type { ClausePair, Verdict } from "./types.ts";

/** 规格 §3.5:单批 prompt 字符上限。超过则对半分,**绝不截断正文** ——
 *  截掉的那半句可能正是判覆盖的关键。 */
export const MAX_BATCH_CHARS = 24_000;

const VALID_STATES = new Set<Verdict["state"]>(["covered", "partial", "missing", "conflict"]);

function batchChars(batch: readonly ClausePair[]): number {
	return batch.reduce((n, p) => n + p.externalClause.text.length + p.internalObligation.text.length, 0);
}

/**
 * 阶段 5 的分批。先按 `batchSize` 切,再对超字符上限的批递归对半分。
 *
 * ⚠ 单独一对就超上限时**不再分**(分不动了),原样成批 —— 宁可一次 prompt 偏大,
 * 也不丢数据。这条是 A6「不静默丢」在分批环节的落点。
 */
export function batchPairs(
	pairs: readonly ClausePair[],
	batchSize: number,
	maxChars: number = MAX_BATCH_CHARS,
): ClausePair[][] {
	const out: ClausePair[][] = [];
	for (let i = 0; i < pairs.length; i += batchSize) {
		splitUntilFits(pairs.slice(i, i + batchSize), maxChars, out);
	}
	return out;
}

function splitUntilFits(batch: ClausePair[], maxChars: number, out: ClausePair[][]): void {
	if (batch.length === 0) return;
	if (batch.length === 1 || batchChars(batch) <= maxChars) {
		out.push(batch);
		return;
	}
	const mid = Math.ceil(batch.length / 2);
	splitUntilFits(batch.slice(0, mid), maxChars, out);
	splitUntilFits(batch.slice(mid), maxChars, out);
}

/**
 * 组装一批的 user 消息。`baseIndex` 是这一批第一对在**全局** pairs 数组里的下标 ——
 * 模型回的 `pairIndex` 因此是全局的,阶段 6 直接按它回填,不必再做批内→全局的换算。
 */
export function renderBatchPrompt(batch: readonly ClausePair[], baseIndex: number): string {
	const blocks = batch.map((p, i) =>
		[
			`pairIndex: ${baseIndex + i}`,
			`外规条款(${p.externalClause.clausePath}):`,
			p.externalClause.text,
			`内规条款(${p.internalObligation.docTitle ?? ""} ${p.internalObligation.clausePath ?? ""},情态词「${p.internalObligation.evidence ?? ""}」):`,
			p.internalObligation.text,
		].join("\n"),
	);
	return blocks.join("\n\n---\n\n");
}

/**
 * 解析模型回复。**只收四个字段**(规格 §6.3-2)——模型若多写了 `externalClause` 之类的
 * 正文字段,这里原地丢弃,不让它有机会进最终行表。
 *
 * 解析失败 / 形状不对 → 返回空数组,**不抛**:一批解析不出来由调用方按「该批全部
 * unresolved」处置,比让整个 run 炸掉更可诊断。
 */
export function parseVerdicts(text: string): Verdict[] {
	const extracted = extractJsonBlock(text);
	if (extracted.kind !== "ok") return [];
	const raw = (extracted.value as { verdicts?: unknown }).verdicts;
	if (!Array.isArray(raw)) return [];
	const out: Verdict[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		if (!Number.isInteger(row.pairIndex)) continue;
		if (typeof row.state !== "string" || !VALID_STATES.has(row.state as Verdict["state"])) continue;
		const verdict: Verdict = { pairIndex: row.pairIndex as number, state: row.state as Verdict["state"] };
		if (typeof row.gap === "string" && row.gap !== "") verdict.gap = row.gap;
		if (typeof row.suggestion === "string" && row.suggestion !== "") verdict.suggestion = row.suggestion;
		if (typeof row.conflictType === "string" && row.conflictType !== "") verdict.conflictType = row.conflictType;
		out.push(verdict);
	}
	return out;
}
