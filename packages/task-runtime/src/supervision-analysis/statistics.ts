import type {
	BuildSupervisionStatisticsInput,
	SupervisionIssue,
	SupervisionRelation,
	SupervisionStatistics,
} from "./contracts.ts";

const confirmedIssueStatuses = new Set(["AUTO_CONFIRMED", "HUMAN_CONFIRMED"]);
const confirmedRelationStatuses = new Set(["AUTO_CONFIRMED", "HUMAN_CONFIRMED"]);

function countBy(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

function confirmedIssues(issues: readonly SupervisionIssue[]): SupervisionIssue[] {
	return issues.filter((item) => confirmedIssueStatuses.has(item.confirmationStatus));
}

function confirmedRelations(
	relations: readonly SupervisionRelation[],
	confirmedIssueIds: ReadonlySet<string>,
): SupervisionRelation[] {
	return relations.filter(
		(relation) => confirmedIssueIds.has(relation.issueId) && confirmedRelationStatuses.has(relation.status),
	);
}

export function buildSupervisionStatistics(input: BuildSupervisionStatisticsInput): SupervisionStatistics {
	const issues = confirmedIssues(input.issues);
	const issueIds = new Set(issues.map((item) => item.issueId));
	const relations = confirmedRelations(input.relations, issueIds);
	const rectificationById = new Map(input.rectifications.map((record) => [record.recordId, record]));
	const rectificationRelations = relations.filter((relation) => relation.relationType === "RECTIFICATION");
	const rectificationStatuses = rectificationRelations
		.map((relation) =>
			relation.selectedRecordId ? rectificationById.get(relation.selectedRecordId)?.status : undefined,
		)
		.filter((status): status is NonNullable<typeof status> => status !== undefined);
	const completedStatuses = new Set(["COMPLETED", ...(input.continuousAsCompleted ? ["CONTINUOUS"] : [])]);
	const completedTotal = rectificationStatuses.filter((status) => completedStatuses.has(status)).length;
	const confirmedTotal = rectificationRelations.length;
	const requiredTotal = issues.filter((issue) => issue.requiresRectification).length;
	const matchedIssues = new Set(
		rectificationRelations
			.filter((r) => r.selectedRecordId && rectificationById.has(r.selectedRecordId))
			.map((r) => r.issueId),
	);
	const unmatchedTotal = issues.filter(
		(issue) => issue.requiresRectification && !matchedIssues.has(issue.issueId),
	).length;
	const accountabilityIds = new Set(
		input.accountabilities
			.filter(
				(record) =>
					record.confirmationStatus === "AUTO_CONFIRMED" || record.confirmationStatus === "HUMAN_CONFIRMED",
			)
			.map((record) => record.recordId),
	);
	for (const relation of relations)
		if (
			relation.relationType === "ACCOUNTABILITY" &&
			relation.selectedRecordId &&
			input.accountabilities.some(
				(r) => r.recordId === relation.selectedRecordId && r.confirmationStatus !== "PENDING_REVIEW",
			)
		)
			accountabilityIds.add(relation.selectedRecordId);

	return {
		issueTotal: issues.length,
		pendingIssueReviewTotal: input.issues.length - issues.length,
		pendingRelationReviewTotal: input.relations.length - relations.length,
		bySourceType: countBy(issues.map((item) => item.sourceType)),
		byCategory: countBy(issues.map((item) => item.category)),
		byOrganization: countBy(issues.flatMap((item) => item.organizationIds)),
		rectification: {
			requiredTotal,
			unmatchedTotal,
			coverageRate: requiredTotal === 0 ? 0 : (requiredTotal - unmatchedTotal) / requiredTotal,
			matchedCompletionRate: confirmedTotal === 0 ? 0 : completedTotal / confirmedTotal,
			confirmedTotal,
			completedTotal,
			completionRate: requiredTotal === 0 ? 0 : completedTotal / requiredTotal,
			byStatus: countBy(rectificationStatuses),
		},
		accountability: {
			confirmedTotal: accountabilityIds.size,
		},
	};
}
