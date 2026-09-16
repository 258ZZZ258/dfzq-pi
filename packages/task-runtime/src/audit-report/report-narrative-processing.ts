import type { AuditReportDataset, ReportDraft } from "./report-contracts.ts";
import {
	checkNarrativeCandidate,
	checkNarrativeReview,
	type NarrativeRewriteCandidate,
	type NarrativeRewriteInput,
	prepareNarrativeRewrite,
} from "./report-narrative-rewrite.ts";
import { semanticParagraphs } from "./report-semantic.ts";

export type NarrativeModelRequest =
	| {
			phase: "rewrite";
			input: NarrativeRewriteInput;
			revision?: { candidate: NarrativeRewriteCandidate; review: unknown };
	  }
	| { phase: "review"; input: NarrativeRewriteInput; candidate: NarrativeRewriteCandidate };

/** The host must use the configured runtime, with a fresh context per phase. */
export type NarrativeModelCall = (request: NarrativeModelRequest, signal: AbortSignal) => Promise<unknown>;

export type ReportNarrativeProcessor = (
	dataset: AuditReportDataset,
	draft: ReportDraft,
) => ReturnType<typeof processReportNarratives>;

export interface NarrativeProcessingRecord {
	paragraphId: string;
	status: "accepted" | "retained";
	reason: string;
	input?: NarrativeRewriteInput;
	candidate?: NarrativeRewriteCandidate;
	review?: unknown;
	attempts?: Array<{ candidate: NarrativeRewriteCandidate; review: unknown; errors: string[] }>;
}

/** Does not modify the source dataset, baseline, citations, headings, or fixed overview prefix. */
export async function processReportNarratives(
	dataset: AuditReportDataset,
	baseline: ReportDraft,
	options: { callModel: NarrativeModelCall; signal: AbortSignal },
): Promise<{ draft: ReportDraft; records: NarrativeProcessingRecord[] }> {
	const draft = structuredClone(baseline);
	const records: NarrativeProcessingRecord[] = [];
	if (baseline.status === "needs-input") return { draft, records };
	const evidence = new Set(dataset.evidence.map((item) => item.evidenceId));
	const history = dataset.organization.historyStatement?.trim();
	const events = new Map(dataset.riskEvents.map((event) => [`risk-${event.eventId}`, event]));
	for (const paragraph of semanticParagraphs(draft)) {
		options.signal.throwIfAborted();
		let event = events.get(paragraph.paragraphId);
		if (dataset.task.reportType === "turnover" && paragraph.paragraphId === "turnover-accountability") {
			const matches = dataset.riskEvents.filter(
				(item) =>
					item.type === "accountability" &&
					item.state === "VERIFIED_VALUE" &&
					(item.turnoverDescription ?? item.regularDescription ?? item.description) === paragraph.text &&
					item.evidenceIds.length > 0 &&
					item.evidenceIds.every((id) => paragraph.evidenceIds.includes(id)),
			);
			if (matches.length !== 1) {
				records.push({
					paragraphId: paragraph.paragraphId,
					status: "retained",
					reason: "accountability-source-not-unique",
				});
				continue;
			}
			event = matches[0];
		}
		const isHistory = ["regular-overview", "turnover-overview"].includes(paragraph.paragraphId) && Boolean(history);
		if (!isHistory && (!event || event.state !== "VERIFIED_VALUE")) continue;
		const sourceText = isHistory ? history! : paragraph.text;
		const record: NarrativeProcessingRecord = {
			paragraphId: paragraph.paragraphId,
			status: "retained",
			reason: "not-processed",
		};
		records.push(record);
		// Match a single suffix, never replace arbitrary occurrences in the full overview.
		if (isHistory && !paragraph.text.endsWith(sourceText)) {
			record.reason = "history-source-does-not-match-baseline";
			continue;
		}
		const refs = isHistory ? dataset.organization.evidenceIds : event!.evidenceIds;
		if (!refs.length || refs.some((id) => !evidence.has(id) || !paragraph.evidenceIds.includes(id))) {
			record.reason = "source-evidence-incomplete";
			continue;
		}
		try {
			const input = prepareNarrativeRewrite({
				scope: isHistory ? "organization-history" : "risk-event",
				paragraphId: paragraph.paragraphId,
				text: sourceText,
				evidenceIds: refs,
			});
			record.input = input;
			const proposal = await options.callModel({ phase: "rewrite", input: structuredClone(input) }, options.signal);
			options.signal.throwIfAborted();
			const checked = checkNarrativeCandidate(input, proposal);
			if (!checked.candidate) {
				record.reason = "candidate-validation-failed";
				continue;
			}
			let candidate = checked.candidate;
			record.candidate = candidate;
			if (candidate.text === sourceText) {
				record.reason = "candidate-unchanged";
				continue;
			}
			// Do not accept a review bundled with a proposal. Invoke a separate phase with frozen inputs.
			let review = await options.callModel(
				{ phase: "review", input: structuredClone(input), candidate: structuredClone(candidate) },
				options.signal,
			);
			options.signal.throwIfAborted();
			record.review = review;
			let reviewErrors = checkNarrativeReview(input, candidate, review);
			record.attempts = [{ candidate, review, errors: reviewErrors }];
			// One quality-only repair under the same shared turn ceiling. Never repair a factual rejection into acceptance.
			if (reviewErrors.length === 1 && reviewErrors[0] === "Narrative contains redundant restatement") {
				const revised = await options.callModel(
					{
						phase: "rewrite",
						input: structuredClone(input),
						revision: structuredClone({ candidate, review }),
					},
					options.signal,
				);
				options.signal.throwIfAborted();
				const repaired = checkNarrativeCandidate(input, revised);
				if (!repaired.candidate) {
					record.reason = "quality-repair-validation-failed";
					continue;
				}
				candidate = repaired.candidate;
				record.candidate = candidate;
				review = await options.callModel(
					{ phase: "review", input: structuredClone(input), candidate: structuredClone(candidate) },
					options.signal,
				);
				options.signal.throwIfAborted();
				record.review = review;
				reviewErrors = checkNarrativeReview(input, candidate, review);
				record.attempts.push({ candidate, review, errors: reviewErrors });
			}
			if (reviewErrors.length) {
				record.reason = "semantic-review-failed";
				continue;
			}
			paragraph.text = isHistory ? paragraph.text.slice(0, -sourceText.length) + candidate.text : candidate.text;
			record.status = "accepted";
			record.reason = "candidate-and-review-validated";
		} catch {
			// Parent cancellation must stop delivery, not be converted into a successful fallback.
			options.signal.throwIfAborted();
			record.reason = "narrative-processing-unavailable";
		}
	}
	return { draft, records };
}
