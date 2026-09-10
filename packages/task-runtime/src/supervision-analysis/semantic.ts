import type { AssociateSupervisionRecordsInput } from "./contracts.ts";

export function pairKey(issueId: string, recordId: string): string {
	return JSON.stringify([issueId, recordId]);
}

/** Scores are computed on scoped texts, never accepted from task payloads. */
export async function computeAssociationScores(
	input: AssociateSupervisionRecordsInput,
): Promise<ReadonlyMap<string, number>> {
	const pairs = input.issues.flatMap((issue) =>
		[
			...(issue.requiresRectification ? input.rectifications : []),
			...(issue.requiresAccountability ? input.accountabilities : []),
		]
			.filter(
				(record) =>
					record.confirmationStatus !== "PENDING_REVIEW" &&
					record.referencedIssueIds.length === 0 &&
					issue.organizationIds.some((id) => record.organizationIds.includes(id)),
			)
			.map((record) => ({
				pairId: pairKey(issue.issueId, record.recordId),
				issueText: issue.description,
				recordText: record.description,
			})),
	);
	const unique = [...new Map(pairs.map((pair) => [pair.pairId, pair])).values()];
	const scores = new Map<string, number>();
	if (unique.length === 0) return scores;
	const baseUrl = process.env.AUDIT_AI_BASE_URL;
	const token = process.env.AUDIT_AI_INTERNAL_TOKEN;
	if (!baseUrl || !token)
		throw new Error("Supervision semantic matching requires AUDIT_AI_BASE_URL and AUDIT_AI_INTERNAL_TOKEN");
	for (let start = 0; start < unique.length; start += 64) {
		const batch = unique.slice(start, start + 64);
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/supervision/similarity`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": token },
			body: JSON.stringify({ pairs: batch }),
			signal: AbortSignal.timeout(300000),
		});
		if (!response.ok) throw new Error(`Supervision similarity failed: HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("scores" in body) || !Array.isArray(body.scores))
			throw new Error("Invalid similarity response");
		const expected = new Set(batch.map((pair) => pair.pairId));
		for (const row of body.scores as unknown[]) {
			if (
				!row ||
				typeof row !== "object" ||
				!("pairId" in row) ||
				!("score" in row) ||
				typeof row.pairId !== "string" ||
				!expected.delete(row.pairId) ||
				typeof row.score !== "number" ||
				!Number.isFinite(row.score) ||
				row.score < 0 ||
				row.score > 1
			)
				throw new Error("Invalid pair similarity");
			scores.set(row.pairId, row.score);
		}
		if (expected.size) throw new Error("Incomplete similarity response");
	}
	return scores;
}
