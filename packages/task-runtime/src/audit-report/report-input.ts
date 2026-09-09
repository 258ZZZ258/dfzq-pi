import type { AuditReportDataset, AuditReportType } from "./report-contracts.ts";
import { businessCheckErrors, workflowErrors } from "./report-workflow.ts";

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

/** Java passes a frozen, authorized business snapshot; no endpoint or path is accepted from the client. */
export function parseReportInput(
	payload: Record<string, unknown>,
	taskId: string,
	reportType: AuditReportType,
): AuditReportDataset {
	if (payload.schemaVersion !== "audit-report-input.v2") throw new Error("Expected audit-report-input.v2");
	const raw = object(payload.dataset, "dataset");
	const task = object(raw.task, "dataset.task");
	if (
		!["consultation", "regular", "turnover"].includes(String(task.reportType)) ||
		task.taskId !== taskId ||
		task.reportType !== reportType
	)
		throw new Error("Report input task/type mismatch");
	for (const field of [
		"projectId",
		"organizationId",
		"auditStart",
		"auditEnd",
		"reportDate",
		"templateId",
		"templateVersion",
		"closingOrganization",
		"auditGroupEstablishedMonth",
	])
		if (typeof task[field] !== "string" || !String(task[field]).trim()) throw new Error(`Missing task.${field}`);
	for (const field of ["auditStart", "auditEnd", "reportDate"]) {
		const date = String(task[field]);
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
			!Number.isFinite(Date.parse(date)) ||
			new Date(date).toISOString().slice(0, 10) !== date
		)
			throw new Error(`Invalid task.${field}`);
	}
	if (String(task.auditStart) > String(task.auditEnd)) throw new Error("Invalid audit period");
	const org = object(raw.organization, "organization");
	const workflow = object(task.workflow, "workflow");
	for (const field of ["matchingCompleted", "consultationExists"])
		if (typeof workflow[field] !== "boolean") throw new Error(`workflow.${field} must be boolean`);
	for (const field of [
		"sourceReportId",
		"sourceDataVersion",
		"feedbackCompletedAt",
		"feedbackDeadline",
		"feedbackRequirement",
	])
		if (workflow[field] !== undefined && (typeof workflow[field] !== "string" || !String(workflow[field]).trim()))
			throw new Error(`Invalid workflow.${field}`);
	for (const field of ["feedbackStatus", "resolutionStatus"])
		if (workflow[field] !== undefined && !["pending", "completed"].includes(String(workflow[field])))
			throw new Error(`Invalid workflow.${field}`);
	for (const field of ["feedbackCompletedAt", "feedbackDeadline"])
		if (workflow[field] !== undefined) {
			const date = String(workflow[field]).slice(0, 10);
			if (
				!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
				!Number.isFinite(Date.parse(String(workflow[field]))) ||
				new Date(date).toISOString().slice(0, 10) !== date
			)
				throw new Error(`Invalid workflow.${field}`);
		}
	const personnel = object(raw.personnel, "personnel");
	object(raw.fixedFacts, "fixedFacts");
	if (org.organizationId !== task.organizationId || personnel.organizationId !== task.organizationId)
		throw new Error("Cross-organization snapshot rejected");
	for (const field of [
		"sources",
		"appointments",
		"operatingMetrics",
		"findings",
		"riskEvents",
		"performance",
		"manualDecisions",
		"evidence",
		"checks",
	])
		if (!Array.isArray(raw[field])) throw new Error(`dataset.${field} must be an array`);
	for (const f of raw.findings as unknown[])
		if (
			object(f, "finding").organizationId !== task.organizationId ||
			(object(f, "finding").isHistorical !== true && object(f, "finding").projectId !== task.projectId)
		)
			throw new Error("Cross-project or organization finding rejected");
	const dataset = structuredClone(raw) as unknown as AuditReportDataset;
	const errors = [...workflowErrors(dataset.task), ...businessCheckErrors(dataset)];
	if (errors.length) throw new Error(errors.join("\n"));
	return dataset;
}
