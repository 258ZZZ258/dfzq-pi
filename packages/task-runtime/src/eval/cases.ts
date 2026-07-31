import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface EvalCase {
	id: string;
	level: string;
	category: string;
	caseFamily: string;
	promptVariants: Record<string, string>;
}

/**
 * 5 题子集,每个 case_family 取 1(规格 §1.4.0)。
 *
 * 形式 15 题的结构是 5 族 × 3 道。这 5 个 id **定死**,不得为了让判据①变绿而换题。
 * 扩回 15 题走 --all,不改这里。
 */
export const DEFAULT_CASE_IDS: readonly string[] = ["L1-001", "L2-003", "L3-001", "TRAP-002", "L3-007"];

interface RawCase {
	id: string;
	level?: string;
	category?: string;
	case_family?: string;
	prompt_variants?: Record<string, string>;
}

export async function loadFormalCases(evalRoot: string): Promise<EvalCase[]> {
	// ⚠ 是 data/formal_case_rubric/evals.json(15 题),不是 data/evals.json(55 条全集)。
	const path = join(evalRoot, "data", "formal_case_rubric", "evals.json");
	const raw = JSON.parse(await readFile(path, "utf8")) as RawCase[];
	return raw.map((item) => ({
		id: item.id,
		level: item.level ?? "",
		category: item.category ?? "",
		caseFamily: item.case_family ?? "",
		promptVariants: item.prompt_variants ?? {},
	}));
}

export function selectCases(all: EvalCase[], ids: readonly string[]): EvalCase[] {
	const byId = new Map(all.map((item) => [item.id, item]));
	const missing = ids.filter((id) => !byId.has(id));
	// 静默跳过找不到的 id 会让「跑了 5 题」变成「跑了 3 题却报 5 题通过」。响亮失败。
	if (missing.length > 0) {
		throw new Error(`Unknown case id(s): ${missing.join(", ")}. Available: ${[...byId.keys()].join(", ")}`);
	}
	return ids.map((id) => byId.get(id) as EvalCase);
}
