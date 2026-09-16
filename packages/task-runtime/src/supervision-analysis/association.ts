import type {
	AssociateSupervisionRecordsInput,
	SupervisionAccountabilityRecord,
	SupervisionIssue,
	SupervisionMatchMethod,
	SupervisionRectificationRecord,
	SupervisionRelation,
	SupervisionRelationType,
} from "./contracts.ts";
import { isBusinessDate } from "./dates.ts";
import type { AssociationDecision } from "./judgement.ts";
import { pairKey } from "./semantic.ts";

const DEFAULT_AUTO_CONFIRM_THRESHOLD = 0.85;
const DEFAULT_REVIEW_THRESHOLD = 0.65;
const DEFAULT_MULTIPLE_CANDIDATE_MARGIN = 0.08;

type LinkedRecord = SupervisionRectificationRecord | SupervisionAccountabilityRecord;

interface ScoredRecord {
	record: LinkedRecord;
	score: number;
	method: SupervisionMatchMethod;
}

function normalizeReference(value: string): string {
	return value.toLowerCase().replace(/[\s·•,，。；;:：()（）[\]【】]/gu, "");
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
	const rightValues = new Set(right);
	return left.some((value) => rightValues.has(value));
}

function clampScore(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function scoreRecord(issue: SupervisionIssue, record: LinkedRecord, scores: ReadonlyMap<string, number>): ScoredRecord {
	if (record.confirmationStatus === "PENDING_REVIEW") return { record, score: 0, method: "NONE" };
	if (record.referencedIssueIds.includes(issue.issueId)) {
		return { record, score: 1, method: "EXACT_ISSUE_ID" };
	}
	// An explicit reference to another issue must not fall back to a semantic match.
	if (record.referencedIssueIds.length > 0) return { record, score: 0, method: "NONE" };
	if (!overlaps(issue.organizationIds, record.organizationIds)) return { record, score: 0, method: "NONE" };
	const normalizedIssueNumber = issue.documentNumber ? normalizeReference(issue.documentNumber) : undefined;
	if (
		normalizedIssueNumber &&
		record.referencedDocumentNumbers.some(
			(documentNumber) => normalizeReference(documentNumber) === normalizedIssueNumber,
		)
	) {
		// A shared document identifies a candidate, never a specific issue.
		return {
			record,
			score: Math.max(0.65, clampScore(scores.get(pairKey(issue.issueId, record.recordId))) * 0.75 + 0.15),
			method: "EXACT_DOCUMENT_NUMBER",
		};
	}

	const semantic = clampScore(scores.get(pairKey(issue.issueId, record.recordId))) * 0.75;
	const organization = overlaps(issue.organizationIds, record.organizationIds) ? 0.15 : 0;
	const department = overlaps(issue.responsibleDepartmentIds, record.responsibleDepartmentIds) ? 0.1 : 0;
	return { record, score: Number((semantic + organization + department).toFixed(4)), method: "COMPOSITE" };
}

function isRectification(record: LinkedRecord): record is SupervisionRectificationRecord {
	return "status" in record;
}

function buildRelation(
	issue: SupervisionIssue,
	relationType: SupervisionRelationType,
	records: readonly LinkedRecord[],
	thresholds: { auto: number; review: number; margin: number },
	scores: ReadonlyMap<string, number>,
	decisions: ReadonlyMap<string, AssociationDecision>,
): SupervisionRelation {
	let scored = records
		.map((record) => scoreRecord(issue, record, scores))
		.filter((candidate) => candidate.score >= thresholds.review)
		.filter(
			(candidate) =>
				candidate.method === "EXACT_ISSUE_ID" ||
				decisions.get(pairKey(issue.issueId, candidate.record.recordId))?.verdict !== "NO_MATCH",
		)
		.sort((left, right) => right.score - left.score || left.record.recordId.localeCompare(right.record.recordId));
	const confirmed = (candidate: ScoredRecord) =>
		candidate.method === "EXACT_ISSUE_ID" ||
		decisions.get(pairKey(issue.issueId, candidate.record.recordId))?.verdict === "MATCH";
	const history = scored.filter(confirmed);
	if (
		relationType === "RECTIFICATION" &&
		history.length > 1 &&
		history.every((candidate) => isBusinessDate(candidate.record.asOfDate))
	) {
		const latest = history
			.map((candidate) => candidate.record.asOfDate!)
			.sort()
			.at(-1)!;
		// Only confirmed item-level matches establish a history; similarity alone does not.
		scored = scored.filter((candidate) => !confirmed(candidate) || candidate.record.asOfDate === latest);
	}
	const relationId = `${issue.issueId}:${relationType}`;
	if (scored.length === 0) {
		return {
			relationId,
			issueId: issue.issueId,
			relationType,
			status: "UNMATCHED",
			matchMethod: "NONE",
			matchScore: 0,
			candidateRecordIds: [],
			evidenceIds: [],
		};
	}

	const top = scored[0];
	if (!top) throw new Error("scored candidates unexpectedly empty");
	const exactCandidates = scored.filter(confirmed);
	const rectificationStates = new Set(
		exactCandidates.flatMap((candidate) => (isRectification(candidate.record) ? [candidate.record.status] : [])),
	);
	if (relationType === "RECTIFICATION" && exactCandidates.length > 1 && rectificationStates.size > 1) {
		return {
			relationId,
			issueId: issue.issueId,
			relationType,
			status: "STATUS_CONFLICT",
			matchMethod: top.method,
			matchScore: top.score,
			candidateRecordIds: exactCandidates.map((candidate) => candidate.record.recordId),
			evidenceIds: exactCandidates.flatMap((candidate) => candidate.record.evidenceIds),
		};
	}

	const second = scored[1];
	if (second && (exactCandidates.length > 1 || top.score - second.score < thresholds.margin)) {
		return {
			relationId,
			issueId: issue.issueId,
			relationType,
			status: "MULTIPLE_CANDIDATES",
			matchMethod: top.method,
			matchScore: top.score,
			candidateRecordIds: scored.map((candidate) => candidate.record.recordId),
			evidenceIds: scored.flatMap((candidate) => candidate.record.evidenceIds),
		};
	}

	// Similarity/document number alone cannot establish an issue-level fact.
	const autoConfirmed = top.method === "EXACT_ISSUE_ID" || (confirmed(top) && scored.length === 1);
	return {
		relationId,
		issueId: issue.issueId,
		relationType,
		status: autoConfirmed ? "AUTO_CONFIRMED" : "PENDING_REVIEW",
		matchMethod: top.method,
		matchScore: top.score,
		candidateRecordIds: [top.record.recordId],
		...(autoConfirmed ? { selectedRecordId: top.record.recordId } : {}),
		evidenceIds: [...new Set([...issue.evidenceIds, ...top.record.evidenceIds])],
	};
}

export function associateSupervisionRecords(
	input: AssociateSupervisionRecordsInput,
	scores: ReadonlyMap<string, number> = new Map(),
	decisions: ReadonlyMap<string, AssociationDecision> = new Map(),
): SupervisionRelation[] {
	// A record matching multiple issues cannot be assigned uniquely by pairwise judgements.
	const matchCounts = new Map<string, number>();
	for (const [key, decision] of decisions) {
		const [, recordId] = JSON.parse(key) as [string, string];
		if (decision.verdict !== "NO_MATCH") matchCounts.set(recordId, (matchCounts.get(recordId) ?? 0) + 1);
	}
	const safeDecisions = new Map(
		[...decisions].map(([key, decision]) => {
			const [, recordId] = JSON.parse(key) as [string, string];
			return [
				key,
				decision.verdict === "MATCH" && (matchCounts.get(recordId) ?? 0) > 1
					? { ...decision, verdict: "UNCERTAIN" as const }
					: decision,
			];
		}),
	);
	const thresholds = {
		auto: input.autoConfirmThreshold ?? DEFAULT_AUTO_CONFIRM_THRESHOLD,
		review: input.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD,
		margin: input.multipleCandidateMargin ?? DEFAULT_MULTIPLE_CANDIDATE_MARGIN,
	};
	if (thresholds.auto < thresholds.review) {
		throw new Error("autoConfirmThreshold must be greater than or equal to reviewThreshold");
	}

	const relations: SupervisionRelation[] = [];
	for (const currentIssue of input.issues) {
		if (currentIssue.requiresRectification) {
			relations.push(
				buildRelation(currentIssue, "RECTIFICATION", input.rectifications, thresholds, scores, safeDecisions),
			);
		}
		if (currentIssue.requiresAccountability) {
			relations.push(
				buildRelation(currentIssue, "ACCOUNTABILITY", input.accountabilities, thresholds, scores, safeDecisions),
			);
		}
	}
	return relations;
}

export function associationCandidates(
	input: AssociateSupervisionRecordsInput,
	scores: ReadonlyMap<string, number>,
): ReadonlySet<string> {
	return new Set(
		input.issues.flatMap((issue) =>
			[
				...(issue.requiresRectification ? input.rectifications : []),
				...(issue.requiresAccountability ? input.accountabilities : []),
			]
				.filter(
					(record) =>
						record.referencedIssueIds.length === 0 &&
						scoreRecord(issue, record, scores).score >= (input.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD),
				)
				.map((record) => pairKey(issue.issueId, record.recordId)),
		),
	);
}
