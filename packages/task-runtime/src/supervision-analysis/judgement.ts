import type { AssociateSupervisionRecordsInput } from "./contracts.ts";
import { pairKey } from "./semantic.ts";

export interface AssociationDecision {
	pairId: string;
	verdict: "MATCH" | "NO_MATCH" | "UNCERTAIN";
	reason: string;
	issueQuote: string;
	recordQuote: string;
}

export async function judgeAssociationCandidates(
	input: AssociateSupervisionRecordsInput,
	candidates: ReadonlySet<string>,
): Promise<ReadonlyMap<string, AssociationDecision>> {
	const pairs = input.issues.flatMap((issue) =>
		[
			...(issue.requiresRectification ? input.rectifications : []),
			...(issue.requiresAccountability ? input.accountabilities : []),
		]
			.filter((record) => candidates.has(pairKey(issue.issueId, record.recordId)))
			.map((record) => ({
				pairId: pairKey(issue.issueId, record.recordId),
				issueText: issue.description,
				recordText: record.description,
			})),
	);
	const decisions = new Map<string, AssociationDecision>();
	if (!pairs.length) return decisions;
	if (new Set(pairs.map((p) => p.pairId)).size !== pairs.length) throw new Error("Duplicate association pair IDs");
	const baseUrl = process.env.AUDIT_AI_BASE_URL;
	const token = process.env.AUDIT_AI_INTERNAL_TOKEN;
	if (!baseUrl || !token) throw new Error("Supervision association backend is not configured");
	for (let start = 0; start < pairs.length; start += 8) {
		const batch = pairs.slice(start, start + 8);
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/supervision/associate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": token },
			body: JSON.stringify({ pairs: batch }),
			signal: AbortSignal.timeout(300000),
		});
		if (!response.ok) throw new Error(`Supervision association failed: HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || !("decisions" in body) || !Array.isArray(body.decisions))
			throw new Error("Invalid association response");
		const remaining = new Map(batch.map((p) => [p.pairId, p]));
		for (const value of body.decisions as unknown[]) {
			if (!value || typeof value !== "object") throw new Error("Invalid decision");
			const row = value as Record<string, unknown>;
			const pair = typeof row.pairId === "string" ? remaining.get(row.pairId) : undefined;
			if (
				!pair ||
				!["MATCH", "NO_MATCH", "UNCERTAIN"].includes(String(row.verdict)) ||
				typeof row.reason !== "string" ||
				!row.reason.trim() ||
				typeof row.issueQuote !== "string" ||
				!row.issueQuote.trim() ||
				!pair.issueText.includes(row.issueQuote) ||
				typeof row.recordQuote !== "string" ||
				!row.recordQuote.trim() ||
				!pair.recordText.includes(row.recordQuote)
			)
				throw new Error("Invalid association evidence");
			decisions.set(pair.pairId, {
				pairId: pair.pairId,
				verdict: row.verdict as AssociationDecision["verdict"],
				reason: row.reason,
				issueQuote: row.issueQuote,
				recordQuote: row.recordQuote,
			});
			remaining.delete(pair.pairId);
		}
		if (remaining.size) throw new Error("Incomplete association decisions");
	}
	return decisions;
}
