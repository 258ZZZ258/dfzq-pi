import type {
	CreateMaterialSnapshotInput,
	ExcludedMaterial,
	SupervisionAccountabilityRecord,
	SupervisionAnalysisPayload,
	SupervisionAnalysisScope,
	SupervisionMaterial,
	SupervisionMaterialSnapshot,
	SupervisionRectificationRecord,
	SupervisionRetrievalScope,
} from "./contracts.ts";
import { isBusinessDate } from "./dates.ts";
import { selectLatestLitigation } from "./litigation.ts";
import { parseSupervisionTask } from "./task.ts";

function exclusionReason(
	material: SupervisionMaterial,
	task: CreateMaterialSnapshotInput["task"],
): ExcludedMaterial["reason"] | undefined {
	if (material.processingStatus !== "indexed") return material.processingStatus;
	if (!material.organizationIds.includes(task.organizationId)) return "ORGANIZATION_NOT_MATCHED";
	if (!material.fileDate) return "MISSING_FILE_DATE";
	if (!isBusinessDate(material.fileDate)) return "INVALID_FILE_DATE";
	if (material.fileDate < task.analysisStart || material.fileDate > task.analysisEnd) {
		return "OUTSIDE_ANALYSIS_PERIOD";
	}
	return undefined;
}

export function createMaterialSnapshot(input: CreateMaterialSnapshotInput): SupervisionMaterialSnapshot {
	const task = parseSupervisionTask(input.task);
	const seenVersions = new Set<string>();
	const included: SupervisionMaterial[] = [];
	const excluded: ExcludedMaterial[] = [];
	for (const material of input.materials) {
		if (seenVersions.has(material.documentVersionId)) {
			throw new Error(`duplicate documentVersionId in material snapshot: ${material.documentVersionId}`);
		}
		seenVersions.add(material.documentVersionId);
		const reason = exclusionReason(material, task);
		if (reason) {
			excluded.push({
				documentId: material.documentId,
				documentVersionId: material.documentVersionId,
				reason,
			});
		} else {
			included.push(material);
		}
	}

	return {
		taskId: input.task.taskId,
		snapshotAt: input.snapshotAt,
		included,
		excluded,
	};
}

export function buildSupervisionRetrievalScope(
	task: CreateMaterialSnapshotInput["task"],
	snapshot: SupervisionMaterialSnapshot,
): SupervisionRetrievalScope {
	return {
		taskId: task.taskId,
		organizationId: task.organizationId,
		documentIds: snapshot.included.map((material) => material.documentId),
		documentVersionIds: snapshot.included.map((material) => material.documentVersionId),
		indexVersions: [...new Set(snapshot.included.map((material) => material.indexVersion))],
	};
}

export function scopeSupervisionAnalysisPayload(payload: SupervisionAnalysisPayload): SupervisionAnalysisScope {
	const snapshot = createMaterialSnapshot({
		task: payload.task,
		snapshotAt: payload.snapshotAt,
		materials: payload.materials,
	});
	const materialByVersion = new Map(snapshot.included.map((material) => [material.documentVersionId, material]));
	const issues = selectLatestLitigation(
		payload.issues.filter((issue) => {
			const material = materialByVersion.get(issue.sourceDocumentVersionId);
			if (
				!material ||
				material.documentId !== issue.sourceDocumentId ||
				!issue.organizationIds.includes(payload.task.organizationId)
			)
				return false;
			const discoveredDate = issue.discoveredDate ?? material.fileDate;
			if (!isBusinessDate(discoveredDate)) throw new Error(`Invalid discoveredDate for issue ${issue.issueId}`);
			return discoveredDate >= payload.task.analysisStart && discoveredDate <= payload.task.analysisEnd;
		}),
		payload.task,
	);
	const issueIds = new Set(issues.map((issue) => issue.issueId));
	const scopeRecords = <T extends SupervisionRectificationRecord | SupervisionAccountabilityRecord>(
		records: readonly T[],
	): T[] =>
		records.flatMap((record) => {
			const matchesIssue = record.referencedIssueIds.some((id) => issueIds.has(id));
			if (record.referencedIssueIds.length > 0 && !matchesIssue) return [];
			if (!record.organizationIds.includes(payload.task.organizationId) && !matchesIssue) return [];
			const versions = snapshot.included.filter(
				(material) =>
					material.documentId === record.sourceDocumentId &&
					(record.sourceDocumentVersionId === undefined ||
						record.sourceDocumentVersionId === material.documentVersionId),
			);
			if (versions.length === 0) return [];
			if (versions.length !== 1) throw new Error(`Ambiguous source document version for record ${record.recordId}`);
			const material = versions[0]!;
			const asOfDate = record.asOfDate ?? material.fileDate;
			if (!isBusinessDate(asOfDate)) throw new Error(`Invalid asOfDate for record ${record.recordId}`);
			if (asOfDate < payload.task.analysisStart || asOfDate > payload.task.analysisEnd) return [];
			return [{ ...record, sourceDocumentVersionId: material.documentVersionId, asOfDate }];
		});
	const rectifications = scopeRecords(payload.rectifications);
	const accountabilities = scopeRecords(payload.accountabilities);
	return {
		snapshot,
		issues,
		rectifications,
		accountabilities,
	};
}
