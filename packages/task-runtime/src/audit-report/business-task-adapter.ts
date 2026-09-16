import type { BusinessTaskMetadata, BusinessTaskRecord } from "../business-data/contracts.ts";
import type { AuditReportType, ReportTask, ReportWorkflow } from "./report-contracts.ts";

export interface AuditReportTaskExtension {
	projectId: string;
	reportType: AuditReportType;
	auditGroupEstablishedMonth: string;
	reportDate: string;
	templateId: string;
	templateVersion: string;
	closingOrganization: string;
	subjectPersonId?: string;
	subjectPersonName?: string;
	appointmentStart?: string;
	appointmentEnd?: string;
	feedbackCompleted: boolean;
	workflow?: ReportWorkflow;
}

function assertPeriod(start: string, end: string): void {
	if (start > end) throw new Error(`task period start ${start} must not be after end ${end}`);
}

export function toAuditBusinessTaskRecord(task: ReportTask, metadata: BusinessTaskMetadata): BusinessTaskRecord {
	assertPeriod(task.auditStart, task.auditEnd);
	return {
		taskId: task.taskId,
		...metadata,
		taskType: "AUDIT_REPORT",
		taskSubtype: task.reportType.toUpperCase(),
		organizationId: task.organizationId,
		periodStart: task.auditStart,
		periodEnd: task.auditEnd,
	};
}

export function toAuditReportTask(task: BusinessTaskRecord, extension: AuditReportTaskExtension): ReportTask {
	if (task.taskType !== "AUDIT_REPORT") {
		throw new Error(`business task ${task.taskId} is ${task.taskType}, expected AUDIT_REPORT`);
	}
	if (task.taskSubtype !== extension.reportType.toUpperCase()) {
		throw new Error(
			`business task ${task.taskId} subtype ${task.taskSubtype} does not match report type ${extension.reportType}`,
		);
	}
	assertPeriod(task.periodStart, task.periodEnd);
	return {
		taskId: task.taskId,
		projectId: extension.projectId,
		reportType: extension.reportType,
		organizationId: task.organizationId,
		auditStart: task.periodStart,
		auditEnd: task.periodEnd,
		auditGroupEstablishedMonth: extension.auditGroupEstablishedMonth,
		reportDate: extension.reportDate,
		templateId: extension.templateId,
		templateVersion: extension.templateVersion,
		closingOrganization: extension.closingOrganization,
		...(extension.subjectPersonId ? { subjectPersonId: extension.subjectPersonId } : {}),
		...(extension.subjectPersonName ? { subjectPersonName: extension.subjectPersonName } : {}),
		...(extension.appointmentStart ? { appointmentStart: extension.appointmentStart } : {}),
		...(extension.appointmentEnd ? { appointmentEnd: extension.appointmentEnd } : {}),
		feedbackCompleted: extension.feedbackCompleted,
		workflow: extension.workflow,
	};
}
