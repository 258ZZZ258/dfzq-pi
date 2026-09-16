import type {
	BusinessIssueRecord,
	BusinessTaskMetadata,
	BusinessTaskRecord,
	TaskMaterialSnapshotItemRecord,
	TaskMaterialSnapshotRecord,
} from "../business-data/contracts.ts";
import type {
	SupervisionIssue,
	SupervisionMaterial,
	SupervisionMaterialSnapshot,
	SupervisionTaskDescriptor,
} from "./contracts.ts";
import { parseSupervisionTask } from "./task.ts";

export interface SupervisionTaskConfigRecord {
	taskId: string;
	analysisDescription?: string;
	extractionRuleVersion: string;
	continuousAsCompleted: boolean;
}

export function toSupervisionBusinessTaskRecord(
	task: SupervisionTaskDescriptor,
	metadata: BusinessTaskMetadata,
): BusinessTaskRecord {
	parseSupervisionTask(task);
	return {
		taskId: task.taskId,
		...metadata,
		taskType: "SUPERVISION_ANALYSIS",
		taskSubtype: "SUPERVISION_SHARED",
		organizationId: task.organizationId,
		periodStart: task.analysisStart,
		periodEnd: task.analysisEnd,
	};
}

export function toSupervisionTaskDescriptor(
	task: BusinessTaskRecord,
	config: SupervisionTaskConfigRecord,
): SupervisionTaskDescriptor {
	if (task.taskType !== "SUPERVISION_ANALYSIS") {
		throw new Error(`business task ${task.taskId} is ${task.taskType}, expected SUPERVISION_ANALYSIS`);
	}
	if (task.taskId !== config.taskId) {
		throw new Error(`supervision task config ${config.taskId} does not belong to business task ${task.taskId}`);
	}
	return parseSupervisionTask({
		taskId: task.taskId,
		analysisStart: task.periodStart,
		analysisEnd: task.periodEnd,
		organizationId: task.organizationId,
		analysisDescription: config.analysisDescription,
	});
}

export function toTaskMaterialSnapshotRecords(
	snapshotId: string,
	snapshot: SupervisionMaterialSnapshot,
	materials: readonly SupervisionMaterial[],
): { snapshot: TaskMaterialSnapshotRecord; items: TaskMaterialSnapshotItemRecord[] } {
	const materialByVersion = new Map(materials.map((material) => [material.documentVersionId, material]));
	const toItem = (
		material: SupervisionMaterial,
		inclusionStatus: TaskMaterialSnapshotItemRecord["inclusionStatus"],
		exclusionReason?: string,
	): TaskMaterialSnapshotItemRecord => ({
		snapshotItemId: `${snapshotId}:${material.documentVersionId}`,
		snapshotId,
		documentId: material.documentId,
		documentVersionId: material.documentVersionId,
		parseVersion: material.parseVersion,
		indexVersion: material.indexVersion,
		title: material.title,
		sourceType: material.sourceType,
		uploadEntry: material.uploadEntry,
		processingStatus: material.processingStatus,
		...(material.fileDate ? { fileDate: material.fileDate } : {}),
		organizationIds: material.organizationIds,
		inclusionStatus,
		...(exclusionReason ? { exclusionReason } : {}),
	});

	const includedItems = snapshot.included.map((material) => toItem(material, "INCLUDED"));
	const excludedItems = snapshot.excluded.map((excluded) => {
		const material = materialByVersion.get(excluded.documentVersionId);
		if (!material) {
			throw new Error(`snapshot exclusion references unknown document version ${excluded.documentVersionId}`);
		}
		return toItem(material, "EXCLUDED", excluded.reason);
	});
	return {
		snapshot: {
			snapshotId,
			taskId: snapshot.taskId,
			snapshotAt: snapshot.snapshotAt,
			snapshotStatus: "FROZEN",
			includedCount: includedItems.length,
			excludedCount: excludedItems.length,
		},
		items: [...includedItems, ...excludedItems],
	};
}

export function toBusinessIssueRecord(task: SupervisionTaskDescriptor, issue: SupervisionIssue): BusinessIssueRecord {
	if (!issue.organizationIds.includes(task.organizationId)) {
		throw new Error(`issue ${issue.issueId} is outside task organization ${task.organizationId}`);
	}
	return {
		issueId: issue.issueId,
		taskId: task.taskId,
		organizationId: task.organizationId,
		sourceDocumentId: issue.sourceDocumentId,
		sourceDocumentVersionId: issue.sourceDocumentVersionId,
		title: issue.title,
		description: issue.description,
		category: issue.category,
		severity: issue.severity,
		confirmationStatus: issue.confirmationStatus,
		evidenceIds: issue.evidenceIds,
	};
}
