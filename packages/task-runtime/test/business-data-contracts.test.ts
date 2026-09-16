import { describe, expect, it } from "vitest";
import { toAuditBusinessTaskRecord, toAuditReportTask } from "../src/audit-report/business-task-adapter.ts";
import type { ReportTask } from "../src/audit-report/report-contracts.ts";
import type { BusinessTaskMetadata } from "../src/business-data/contracts.ts";
import {
	toBusinessIssueRecord,
	toSupervisionBusinessTaskRecord,
	toSupervisionTaskDescriptor,
	toTaskMaterialSnapshotRecords,
} from "../src/supervision-analysis/business-data-adapter.ts";
import type {
	SupervisionIssue,
	SupervisionMaterial,
	SupervisionTaskDescriptor,
} from "../src/supervision-analysis/contracts.ts";
import { createMaterialSnapshot } from "../src/supervision-analysis/snapshot.ts";

const metadata: BusinessTaskMetadata = {
	taskCode: "TASK-2026-001",
	taskName: "江阴人民东路营业部监督共享分析",
	taskStatus: "DRAFT",
	versionNo: 1,
	createdBy: "PER-001",
	createdAt: "2026-09-02T10:00:00+08:00",
	updatedBy: "PER-001",
	updatedAt: "2026-09-02T10:00:00+08:00",
};

const supervisionTask: SupervisionTaskDescriptor = {
	taskId: "TASK-SUP-001",
	organizationId: "BR-001",
	analysisStart: "2026-01-01",
	analysisEnd: "2026-06-30",
};

function material(overrides: Partial<SupervisionMaterial> = {}): SupervisionMaterial {
	return {
		documentId: "DOC-001",
		documentVersionId: "DOC-001-V1",
		parseVersion: "parse-v1",
		indexVersion: "index-v1",
		title: "监管函",
		sourceType: "regulatory",
		uploadEntry: "file-center",
		processingStatus: "indexed",
		fileDate: "2026-05-10",
		organizationIds: ["BR-001"],
		...overrides,
	};
}

describe("shared business task records", () => {
	it("maps audit-report and supervision task settings into the same business task shape", () => {
		const reportTask: ReportTask = {
			taskId: "TASK-AUDIT-001",
			projectId: "PRJ-001",
			reportType: "regular",
			organizationId: "BR-001",
			auditStart: "2025-01-01",
			auditEnd: "2025-12-31",
			auditGroupEstablishedMonth: "2026-01",
			reportDate: "2026-02-01",
			templateId: "TPL-001",
			templateVersion: "2026.01",
			closingOrganization: "东方证券股份有限公司审计中心",
			feedbackCompleted: true,
		};

		const auditRecord = toAuditBusinessTaskRecord(reportTask, {
			...metadata,
			taskCode: "AUDIT-2026-001",
			taskName: "江阴人民东路营业部常规审计",
		});
		const supervisionRecord = toSupervisionBusinessTaskRecord(supervisionTask, metadata);

		expect(Object.keys(auditRecord)).toEqual(Object.keys(supervisionRecord));
		expect(auditRecord).toMatchObject({
			taskType: "AUDIT_REPORT",
			taskSubtype: "REGULAR",
			organizationId: "BR-001",
			periodStart: "2025-01-01",
			periodEnd: "2025-12-31",
		});
		expect(
			toAuditReportTask(auditRecord, {
				projectId: reportTask.projectId,
				reportType: reportTask.reportType,
				auditGroupEstablishedMonth: reportTask.auditGroupEstablishedMonth,
				reportDate: reportTask.reportDate,
				templateId: reportTask.templateId,
				templateVersion: reportTask.templateVersion,
				closingOrganization: reportTask.closingOrganization,
				feedbackCompleted: reportTask.feedbackCompleted,
			}),
		).toEqual(reportTask);
		expect(supervisionRecord).toMatchObject({
			taskType: "SUPERVISION_ANALYSIS",
			taskSubtype: "SUPERVISION_SHARED",
			organizationId: "BR-001",
			periodStart: "2026-01-01",
			periodEnd: "2026-06-30",
		});
	});

	it("hydrates task-specific contracts only from the matching common task type", () => {
		const commonTask = toSupervisionBusinessTaskRecord(supervisionTask, metadata);
		expect(
			toSupervisionTaskDescriptor(commonTask, {
				taskId: commonTask.taskId,
				extractionRuleVersion: "2026-08-25.1",
				continuousAsCompleted: false,
			}),
		).toEqual(supervisionTask);

		expect(() =>
			toAuditReportTask(commonTask, {
				projectId: "PRJ-001",
				reportType: "regular",
				auditGroupEstablishedMonth: "2026-01",
				reportDate: "2026-02-01",
				templateId: "TPL-001",
				templateVersion: "2026.01",
				closingOrganization: "东方证券股份有限公司审计中心",
				feedbackCompleted: true,
			}),
		).toThrow(/expected AUDIT_REPORT/u);
	});
});

describe("supervision analysis description configuration", () => {
	it("restores optional analysis context from the supervision task configuration", () => {
		const task = { ...supervisionTask, analysisDescription: "关注整改进展及系统权限管理。" };
		const record = toSupervisionBusinessTaskRecord(task, metadata);
		expect(
			toSupervisionTaskDescriptor(record, {
				taskId: record.taskId,
				analysisDescription: task.analysisDescription,
				extractionRuleVersion: "2026-08-25.1",
				continuousAsCompleted: false,
			}),
		).toEqual(task);
	});
});

describe("shared supervision persistence records", () => {
	it("persists immutable included and excluded document versions from both upload entries", () => {
		const materials = [
			material(),
			material({
				documentId: "DOC-002",
				documentVersionId: "DOC-002-V1",
				uploadEntry: "supervision",
				processingStatus: "failed",
			}),
		];
		const snapshot = createMaterialSnapshot({
			task: supervisionTask,
			snapshotAt: "2026-09-02T11:00:00+08:00",
			materials,
		});
		const records = toTaskMaterialSnapshotRecords("SNAP-001", snapshot, materials);

		expect(records.snapshot).toMatchObject({
			snapshotId: "SNAP-001",
			taskId: "TASK-SUP-001",
			snapshotStatus: "FROZEN",
			includedCount: 1,
			excludedCount: 1,
		});
		expect(records.items).toEqual([
			expect.objectContaining({
				documentVersionId: "DOC-001-V1",
				parseVersion: "parse-v1",
				indexVersion: "index-v1",
				uploadEntry: "file-center",
				inclusionStatus: "INCLUDED",
			}),
			expect.objectContaining({
				documentVersionId: "DOC-002-V1",
				uploadEntry: "supervision",
				inclusionStatus: "EXCLUDED",
				exclusionReason: "failed",
			}),
		]);
	});

	it("maps a confirmed extracted issue to the common issue record with source lineage", () => {
		const issue: SupervisionIssue = {
			issueId: "ISSUE-001",
			extractionRuleId: "external-regulatory-letter",
			reportSection: "external.regulatory",
			sourceDocumentId: "DOC-001",
			sourceDocumentVersionId: "DOC-001-V1",
			sourceType: "regulatory",
			title: "信息公示不完整",
			description: "营业部未完整公示人员信息",
			organizationIds: ["BR-001"],
			responsibleDepartmentIds: [],
			category: "综合管理",
			severity: "medium",
			confirmationStatus: "AUTO_CONFIRMED",
			requiresRectification: true,
			requiresAccountability: false,
			fieldValues: {},
			evidenceIds: ["E-001"],
		};

		expect(toBusinessIssueRecord(supervisionTask, issue)).toEqual({
			issueId: "ISSUE-001",
			taskId: "TASK-SUP-001",
			organizationId: "BR-001",
			sourceDocumentId: "DOC-001",
			sourceDocumentVersionId: "DOC-001-V1",
			title: "信息公示不完整",
			description: "营业部未完整公示人员信息",
			category: "综合管理",
			severity: "medium",
			confirmationStatus: "AUTO_CONFIRMED",
			evidenceIds: ["E-001"],
		});
	});
});
