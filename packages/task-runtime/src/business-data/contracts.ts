export type BusinessTaskType = "AUDIT_REPORT" | "SUPERVISION_ANALYSIS";

export type BusinessTaskStatus =
	| "DRAFT"
	| "READY"
	| "RUNNING"
	| "REVIEWING"
	| "COMPLETED"
	| "CLOSED"
	| "CANCELLED"
	| "FAILED";

/**
 * Java/数据库持久化的公共业务任务记录。
 * taskId 是稳定业务标识；一次模型执行使用 store.RunRecord.runId，二者不能互换。
 */
export interface BusinessTaskRecord {
	taskId: string;
	taskCode: string;
	taskName: string;
	taskType: BusinessTaskType;
	taskSubtype: string;
	organizationId: string;
	periodStart: string;
	periodEnd: string;
	taskStatus: BusinessTaskStatus;
	versionNo: number;
	createdBy: string;
	createdAt: string;
	updatedBy: string;
	updatedAt: string;
}

export interface BusinessTaskMetadata {
	taskCode: string;
	taskName: string;
	taskStatus: BusinessTaskStatus;
	versionNo: number;
	createdBy: string;
	createdAt: string;
	updatedBy: string;
	updatedAt: string;
}

export interface OrganizationScopedTask {
	taskId: string;
	organizationId: string;
}

export interface IndexedDocumentVersionRecord {
	documentId: string;
	documentVersionId: string;
	parseVersion: string;
	indexVersion: string;
	title: string;
	processingStatus: string;
	fileDate?: string;
	organizationIds: readonly string[];
}

export interface TaskMaterialSnapshotRecord {
	snapshotId: string;
	taskId: string;
	snapshotAt: string;
	snapshotStatus: "FROZEN";
	includedCount: number;
	excludedCount: number;
}

export interface TaskMaterialSnapshotItemRecord {
	snapshotItemId: string;
	snapshotId: string;
	documentId: string;
	documentVersionId: string;
	parseVersion: string;
	indexVersion: string;
	title: string;
	sourceType: string;
	uploadEntry: string;
	processingStatus: string;
	fileDate?: string;
	organizationIds: readonly string[];
	inclusionStatus: "INCLUDED" | "EXCLUDED";
	exclusionReason?: string;
}

export interface EvidenceLinkedRecord {
	evidenceIds: readonly string[];
}

export interface DocumentVersionLinkedRecord extends EvidenceLinkedRecord {
	sourceDocumentId: string;
	sourceDocumentVersionId: string;
}

export interface EvidenceReferenceRecord {
	evidenceId: string;
	documentId: string;
	documentVersionId: string;
	locatorType: "PAGE" | "PARAGRAPH" | "TABLE_ROW" | "CHUNK" | "CLAUSE";
	locatorValue: string;
	chunkId?: string;
	clauseId?: string;
	sourceCode?: string;
	sourceDocId?: string;
}

export interface BusinessIssueRecord extends DocumentVersionLinkedRecord {
	issueId: string;
	taskId: string;
	organizationId: string;
	title: string;
	description: string;
	category: string;
	severity: string;
	confirmationStatus: string;
}
