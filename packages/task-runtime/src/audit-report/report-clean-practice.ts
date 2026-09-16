import type { AuditReportDataset } from "./report-contracts.ts";
import type { ControlSummary } from "./report-control-summary.ts";

/** Project checklist facts only; never infer personal innocence or absence of major misconduct. */
export function buildCleanPracticeSummary(dataset: Pick<AuditReportDataset, "checks" | "evidence">): ControlSummary {
	const errors: string[] = [];
	const texts: string[] = [];
	const ids = new Set<string>();
	const records = new Set<string>();
	for (const code of ["廉洁从业管理", "信访及案件"]) {
		const rows = (dataset.checks ?? []).filter((row) => row.code === code);
		const row = rows[0];
		if (rows.length !== 1 || !row || !["conforming", "exception", "not-applicable"].includes(row.result)) {
			errors.push(`clean-practice: ${code}缺失、重复或未完成检查。`);
			continue;
		}
		const fields = row.result !== "conforming" || row.factText?.trim() ? ["result", "factText"] : ["result"];
		const proofs = fields.flatMap((field) => {
			const matches = dataset.evidence.filter(
				(e) => row.evidenceIds.includes(e.evidenceId) && e.sourceId === "DS-03" && e.sourceField === field,
			);
			const expected = field === "result" ? row.result : row.factText;
			return matches.length === 1 && expected?.trim() && matches[0]?.normalizedValue === expected ? matches : [];
		});
		if (
			proofs.length !== fields.length ||
			proofs.some((e) => !e.sourceRecordId || !e.dataVersion || records.has(e.sourceRecordId)) ||
			new Set(proofs.map((e) => e.sourceRecordId)).size !== 1 ||
			new Set(proofs.map((e) => e.dataVersion)).size !== 1
		) {
			errors.push(`clean-practice: ${code}缺少同一记录及版本的检查依据。`);
			continue;
		}
		for (const proof of proofs) {
			ids.add(proof.evidenceId);
			records.add(proof.sourceRecordId);
		}
		const label = row.result === "conforming" ? "符合要求" : row.result === "exception" ? "存在异常" : "不适用";
		const text =
			row.result === "conforming" && row.factText?.trim()
				? row.factText.trim()
				: `${code}检查结果：${label}${row.factText?.trim() ? `，${row.factText.trim()}` : ""}`;
		texts.push(/[。！？]$/u.test(text) ? text : `${text}。`);
	}
	return { text: errors.length ? "" : texts.join(""), evidenceIds: errors.length ? [] : [...ids], errors };
}
