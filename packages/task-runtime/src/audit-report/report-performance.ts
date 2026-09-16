import type { AuditReportDataset, EvidenceRecord } from "./report-contracts.ts";
import type { ControlSummary } from "./report-control-summary.ts";
import { buildUnpublishedPerformanceSummary } from "./report-unpublished-performance.ts";

/** Personal ratings only. No inference from branch operating KPI or ratings to duty compliance. */
export function buildPerformanceSummary(
	dataset: Pick<AuditReportDataset, "task" | "appointments" | "performance" | "performanceAvailability" | "evidence">,
): ControlSummary {
	if (dataset.performanceAvailability !== undefined) return buildUnpublishedPerformanceSummary(dataset);
	const errors: string[] = [];
	const evidenceIds = new Set<string>();
	const texts: string[] = [];
	const selected = dataset.performance.filter(
		(row) => dataset.task.reportType !== "turnover" || row.personId === dataset.task.subjectPersonId,
	);
	const people = [...new Set(selected.map((row) => row.personId))].sort();
	if (dataset.task.reportType === "turnover" && !people.length)
		errors.push("performance: 缺少被审计负责人的年度考核记录。");
	for (const personId of people) {
		const appointments = dataset.appointments.filter((a) => a.personId === personId);
		const names = [...new Set(appointments.map((a) => a.personName.trim()))];
		const name = names[0];
		const nameProofs = dataset.evidence.filter(
			(e) =>
				appointments.some((a) => a.evidenceIds.includes(e.evidenceId)) &&
				e.sourceField === "personName" &&
				e.normalizedValue === name &&
				e.dataVersion &&
				((e.sourceId === "DS-02" && e.sourceRecordId === personId) ||
					(e.sourceId === "DS-05" &&
						dataset.evidence.some(
							(p) =>
								appointments.some((a) => a.evidenceIds.includes(p.evidenceId)) &&
								p.sourceId === "DS-05" &&
								p.sourceField === "personId" &&
								p.sourceRecordId === e.sourceRecordId &&
								p.dataVersion === e.dataVersion &&
								p.normalizedValue === personId,
						))),
		);
		if (
			names.length !== 1 ||
			!name ||
			!nameProofs.length ||
			(dataset.task.reportType === "turnover" && name !== dataset.task.subjectPersonName)
		) {
			errors.push(`performance: ${personId}缺少一致的任职姓名及人员依据。`);
			continue;
		}
		const rows = dataset.performance
			.filter((r) => r.personId === personId)
			.slice()
			.sort((a, b) => a.year - b.year);
		const years = new Set<number>();
		for (const row of rows) {
			const proofs: EvidenceRecord[] = [];
			for (const field of ["personId", "year", "rating"] as const) {
				const candidates = dataset.evidence.filter(
					(e) => row.evidenceIds.includes(e.evidenceId) && e.sourceId === "DS-09" && e.sourceField === field,
				);
				if (candidates.length === 1 && candidates[0]?.normalizedValue === String(row[field]))
					proofs.push(candidates[0]);
			}
			if (
				!Number.isInteger(row.year) ||
				row.year < 1900 ||
				row.year > 9999 ||
				years.has(row.year) ||
				!row.rating.trim() ||
				proofs.length !== 3 ||
				proofs.some((p) => !p.sourceRecordId || !p.dataVersion) ||
				new Set(proofs.map((p) => p.sourceRecordId)).size !== 1 ||
				new Set(proofs.map((p) => p.dataVersion)).size !== 1
			) {
				errors.push(`performance: ${personId}／${row.year}考核重复、无效或与依据不一致。`);
			}
			years.add(row.year);
			for (const proof of proofs) evidenceIds.add(proof.evidenceId);
		}
		for (const proof of nameProofs) {
			evidenceIds.add(proof.evidenceId);
			if (proof.sourceId === "DS-05")
				for (const identity of dataset.evidence.filter(
					(e) =>
						appointments.some((a) => a.evidenceIds.includes(e.evidenceId)) &&
						e.sourceId === "DS-05" &&
						e.sourceField === "personId" &&
						e.sourceRecordId === proof.sourceRecordId &&
						e.dataVersion === proof.dataVersion &&
						e.normalizedValue === personId,
				))
					evidenceIds.add(identity.evidenceId);
		}
		const contiguous = rows.every((row, i) => i === 0 || row.year === rows[i - 1]!.year + 1);
		if (rows.length > 1 && contiguous) {
			const same = rows.every((row) => row.rating === rows[0]!.rating);
			texts.push(
				`${rows[0]!.year}—${rows.at(-1)!.year}年度，公司对${name}同志的绩效考核结果${same ? `均为${rows[0]!.rating}` : `分别为${rows.map((r) => r.rating).join("、")}`}。`,
			);
		} else for (const row of rows) texts.push(`${row.year}年度，公司对${name}同志的绩效考核结果为${row.rating}。`);
	}
	return { text: errors.length ? "" : texts.join(""), evidenceIds: errors.length ? [] : [...evidenceIds], errors };
}
