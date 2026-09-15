import type { AuditReportDataset } from "./report-contracts.ts";

type TaskDateField = "auditStart" | "auditEnd" | "auditGroupEstablishedMonth" | "reportDate";

/** Resolve only the current task/project's exact field and normalized value, never a global value match. */
export function taskDateEvidence(dataset: AuditReportDataset, field: TaskDateField): string[] {
	const expected = dataset.task[field];
	const projectOrTask = dataset.evidence
		.filter(
			(item) =>
				((item.sourceId === "DS-01" && item.sourceRecordId === dataset.task.taskId) ||
					(item.sourceId === "DS-03" && item.sourceRecordId === dataset.task.projectId)) &&
				item.sourceField === field &&
				item.normalizedValue === expected,
		)
		.map((item) => item.evidenceId);
	return field === "reportDate" ? [...projectOrTask, ...reportFieldEvidence(dataset, field, expected)] : projectOrTask;
}

/** Match a report-owned field only with its same-row, same-version task ownership proof. */
export function reportFieldEvidence(dataset: AuditReportDataset, field: string, expected: string): string[] {
	const bindings = dataset.evidence.filter(
		(item) =>
			item.sourceId === "DS-03" &&
			item.sourceField === "taskId" &&
			item.rawValue === dataset.task.taskId &&
			item.normalizedValue === dataset.task.taskId &&
			Boolean(item.sourceRecordId && item.dataVersion) &&
			item.fileLocation === `database:audit_project_report/${item.sourceRecordId}`,
	);
	if (bindings.length !== 1) return [];
	const binding = bindings[0]!;
	const values = dataset.evidence.filter(
		(item) =>
			item.sourceId === binding.sourceId &&
			item.sourceField === field &&
			item.sourceRecordId === binding.sourceRecordId &&
			item.dataVersion === binding.dataVersion &&
			item.fileLocation === binding.fileLocation &&
			item.rawValue === expected &&
			item.normalizedValue === expected,
	);
	return values.length === 1 ? [binding.evidenceId, values[0]!.evidenceId] : [];
}
