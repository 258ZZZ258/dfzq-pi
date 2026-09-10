export type SupervisionSourceType =
	| "regulatory"
	| "external-audit"
	| "internal-audit"
	| "compliance"
	| "risk"
	| "accountability"
	| "routine-supervision"
	| "litigation";

export type SupervisionUploadEntry = "file-center" | "supervision";
export type SupervisionDataOrigin = "internal" | "official-public" | "synthetic";

export type SupervisionReportSection =
	| "external.regulatory"
	| "external.audit"
	| "internal.audit"
	| "internal.compliance"
	| "internal.risk"
	| "internal.accountability"
	| "internal.daily.compliance"
	| "internal.daily.risk"
	| "internal.daily.litigation";

export interface SupervisionExtractionField {
	key: string;
	label: string;
	required: boolean;
	description: string;
}

export interface SupervisionExtractionRule {
	ruleId: string;
	reportSection: SupervisionReportSection;
	title: string;
	sourceTypes: readonly SupervisionSourceType[];
	documentTypeHints: readonly string[];
	searchKeywords: readonly string[];
	priorityContent: readonly string[];
	extractFields: readonly SupervisionExtractionField[];
	sourceNotes: readonly string[];
	issueCategoryHints: readonly string[];
}

export type MaterialProcessingStatus = "indexed" | "processing" | "failed" | "needs-metadata" | "disabled";

export interface SupervisionMaterial extends IndexedDocumentVersionRecord {
	sourceType: SupervisionSourceType;
	uploadEntry: SupervisionUploadEntry;
	processingStatus: MaterialProcessingStatus;
	dataOrigin?: SupervisionDataOrigin;
	sourceUrl?: string;
}

export type MaterialExclusionReason =
	| Exclude<MaterialProcessingStatus, "indexed">
	| "MISSING_FILE_DATE"
	| "INVALID_FILE_DATE"
	| "OUTSIDE_ANALYSIS_PERIOD"
	| "ORGANIZATION_NOT_MATCHED";

export interface ExcludedMaterial {
	documentId: string;
	documentVersionId: string;
	reason: MaterialExclusionReason;
}

export interface SupervisionMaterialSnapshot {
	taskId: string;
	snapshotAt: string;
	included: readonly SupervisionMaterial[];
	excluded: readonly ExcludedMaterial[];
}

export interface CreateMaterialSnapshotInput {
	task: SupervisionTaskDescriptor;
	snapshotAt: string;
	materials: readonly SupervisionMaterial[];
}

export interface SupervisionRetrievalScope {
	taskId: string;
	organizationId: string;
	documentIds: readonly string[];
	documentVersionIds: readonly string[];
	indexVersions: readonly string[];
}

export interface SupervisionAnalysisScope {
	snapshot: SupervisionMaterialSnapshot;
	issues: readonly SupervisionIssue[];
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
}

export type IssueConfirmationStatus = "AUTO_CONFIRMED" | "HUMAN_CONFIRMED" | "PENDING_REVIEW";

export type IssueSeverity = "low" | "medium" | "high" | "critical" | "unknown";

export interface SupervisionIssue extends DocumentVersionLinkedRecord {
	reviewReasons?: readonly string[];
	issueId: string;
	/** Business discovery date; defaults to the source material's fileDate. */
	discoveredDate?: string;
	extractionRuleId: string;
	reportSection: SupervisionReportSection;
	sourceType: SupervisionSourceType;
	title: string;
	description: string;
	organizationIds: readonly string[];
	responsibleDepartmentIds: readonly string[];
	category: string;
	severity: IssueSeverity;
	confirmationStatus: IssueConfirmationStatus;
	dataOrigin?: SupervisionDataOrigin;
	sourceUrl?: string;
	requiresRectification: boolean;
	requiresAccountability: boolean;
	documentNumber?: string;
	fieldValues: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

interface LinkedRecordBase extends EvidenceLinkedRecord {
	reviewReasons?: readonly string[];
	confirmationStatus?: IssueConfirmationStatus;
	recordId: string;
	sourceDocumentId: string;
	sourceDocumentVersionId?: string;
	/** Date represented by this progress record, never its upload time. */
	asOfDate?: string;
	referencedIssueIds: readonly string[];
	referencedDocumentNumbers: readonly string[];
	organizationIds: readonly string[];
	responsibleDepartmentIds: readonly string[];
	description: string;
	dataOrigin?: SupervisionDataOrigin;
	sourceUrl?: string;
	semanticScore?: number;
}

export type RectificationStatus =
	| "NOT_STARTED"
	| "IN_PROGRESS"
	| "PARTIALLY_COMPLETED"
	| "COMPLETED"
	| "CONTINUOUS"
	| "OVERDUE"
	| "UNABLE"
	| "PENDING_REVIEW";

export interface SupervisionRectificationRecord extends LinkedRecordBase {
	status: RectificationStatus;
}

export interface SupervisionAccountabilityRecord extends LinkedRecordBase {
	action: string;
}

export type SupervisionRelationType = "RECTIFICATION" | "ACCOUNTABILITY";

export type SupervisionRelationStatus =
	| "AUTO_CONFIRMED"
	| "HUMAN_CONFIRMED"
	| "PENDING_REVIEW"
	| "MULTIPLE_CANDIDATES"
	| "STATUS_CONFLICT"
	| "UNMATCHED"
	| "REJECTED";

export type SupervisionMatchMethod = "EXACT_ISSUE_ID" | "EXACT_DOCUMENT_NUMBER" | "COMPOSITE" | "NONE";

export interface SupervisionRelation {
	relationId: string;
	issueId: string;
	relationType: SupervisionRelationType;
	status: SupervisionRelationStatus;
	matchMethod: SupervisionMatchMethod;
	matchScore: number;
	candidateRecordIds: readonly string[];
	selectedRecordId?: string;
	evidenceIds: readonly string[];
}

export interface AssociateSupervisionRecordsInput {
	issues: readonly SupervisionIssue[];
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
	autoConfirmThreshold?: number;
	reviewThreshold?: number;
	multipleCandidateMargin?: number;
}

export interface SupervisionRectificationStatistics {
	requiredTotal: number;
	unmatchedTotal: number;
	coverageRate: number;
	matchedCompletionRate: number;
	confirmedTotal: number;
	completedTotal: number;
	completionRate: number;
	byStatus: Readonly<Record<string, number>>;
}

export interface SupervisionAccountabilityStatistics {
	confirmedTotal: number;
}

export interface SupervisionStatistics {
	issueTotal: number;
	pendingIssueReviewTotal: number;
	pendingRelationReviewTotal: number;
	bySourceType: Readonly<Record<string, number>>;
	byCategory: Readonly<Record<string, number>>;
	byOrganization: Readonly<Record<string, number>>;
	rectification: SupervisionRectificationStatistics;
	accountability: SupervisionAccountabilityStatistics;
}

export interface BuildSupervisionStatisticsInput {
	issues: readonly SupervisionIssue[];
	relations: readonly SupervisionRelation[];
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
	continuousAsCompleted?: boolean;
}

export interface SupervisionTaskDescriptor extends OrganizationScopedTask {
	analysisStart: string;
	analysisEnd: string;
	/** Optional analysis background and special concerns; the report framework remains fixed. */
	analysisDescription?: string;
}

export type SupervisionReadinessStatus = "READY" | "READY_WITH_WARNINGS" | "BLOCKED";

export interface SupervisionReadiness {
	status: SupervisionReadinessStatus;
	blockers: readonly string[];
	warnings: readonly string[];
}

export interface SupervisionAnalysisResult {
	rectifications?: readonly SupervisionRectificationRecord[];
	accountabilities?: readonly SupervisionAccountabilityRecord[];
	schemaVersion: "supervision-analysis.v1";
	extractionRuleVersion: string;
	task: SupervisionTaskDescriptor;
	snapshot: SupervisionMaterialSnapshot;
	issues: readonly SupervisionIssue[];
	relations: readonly SupervisionRelation[];
	statistics: SupervisionStatistics;
	readiness: SupervisionReadiness;
	reportOutline: readonly string[];
}

export interface BuildSupervisionAnalysisResultInput {
	task: SupervisionTaskDescriptor;
	snapshot: SupervisionMaterialSnapshot;
	issues: readonly SupervisionIssue[];
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
	relations: readonly SupervisionRelation[];
	continuousAsCompleted?: boolean;
}

export interface SupervisionAnalysisPayload {
	task: SupervisionTaskDescriptor;
	snapshotAt: string;
	materials: readonly SupervisionMaterial[];
	issues: readonly SupervisionIssue[];
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
	continuousAsCompleted?: boolean;
}

import type {
	DocumentVersionLinkedRecord,
	EvidenceLinkedRecord,
	IndexedDocumentVersionRecord,
	OrganizationScopedTask,
} from "../business-data/contracts.ts";
