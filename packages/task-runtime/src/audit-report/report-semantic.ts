import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuditReportDataset, ReportDraft, ReportParagraph } from "./report-contracts.ts";
import { isTitleOnlyFact } from "./report-fact-text.ts";
import { comparePreviousAuditFindings } from "./report-pipeline.ts";

const PolicySchema = Type.Object(
	{
		enabled: Type.Boolean(),
		summaryFindingThreshold: Type.Integer({ minimum: 2 }),
		maxAttempts: Type.Integer({ minimum: 1, maximum: 3 }),
	},
	{ additionalProperties: false },
);
export type SemanticPolicy = {
	enabled: boolean;
	summaryFindingThreshold: number;
	maxAttempts: number;
};
export function parseSemanticPolicy(value: unknown): SemanticPolicy {
	if (!Value.Check(PolicySchema, value)) throw new Error("Invalid report semantic policy");
	return value;
}

export interface SemanticAtom {
	id: string;
	text: string;
	category?: string;
	major?: boolean;
}
export interface ComparisonIdentity {
	previousObject: string;
	currentObject: string;
	previousFailure: string;
	currentFailure: string;
	objectRelation: "same" | "different" | "insufficient";
	failureRelation: "same" | "different" | "insufficient";
}
export interface SemanticJob {
	id: string;
	kind: "organize" | "summary" | "compare";
	reason: string;
	paragraphIds: string[];
	atoms: SemanticAtom[];
	evidenceIds: string[];
	status: "pending" | "accepted" | "retained" | "failed";
	attempts: number;
	repairAttempts?: number;
	errors: string[];
	text?: string;
	decision?: { sameProblem: boolean; rationale: string };
	comparisons?: Array<{
		currentFindingId: string;
		sameProblem: boolean;
		rationale: string;
		previousFactQuote: string;
		currentFactQuote: string;
		identity: ComparisonIdentity;
	}>;
	comparisonRule?: string;
	previousTitle?: string;
}
export interface SemanticState {
	policy: SemanticPolicy;
	jobs: SemanticJob[];
	ruleMatchedPreviousIds?: string[];
}

export function semanticParagraphs(draft: ReportDraft): ReportParagraph[] {
	return [
		draft.introduction,
		...draft.sections.flatMap((s) => [
			...s.paragraphs,
			...s.subsections.flatMap((sub) => sub.paragraphs),
			...(s.closingParagraphs ?? []),
		]),
	];
}

/** Split only at explicit business boundaries, never at every sentence or semicolon. */
function organizationAtoms(text: string): SemanticAtom[] {
	if (text.includes("\n")) return [];
	const boundaries: number[] = [];
	let quoteDepth = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (/[“「『《]/u.test(char)) quoteDepth++;
		if (/[”」』》]/u.test(char)) quoteDepth = Math.max(0, quoteDepth - 1);
		if (quoteDepth || (index > 0 && !/[。；：！？]/u.test(text[index - 1]!))) continue;
		if (/^(?:（\d+）|\(\d+\)|（[一二三四五六七八九十]+）)/u.test(text.slice(index))) boundaries.push(index);
	}
	if (boundaries.length < 2) {
		return [];
	} else if (boundaries[0]! > 0) {
		// Keep the introductory sentence with the first subitem.
		boundaries.shift();
	}
	if (!boundaries.length) return [];
	const starts = [...new Set([0, ...boundaries])];
	return starts.map((start, index) => ({ id: `s${index + 1}`, text: text.slice(start, starts[index + 1]) }));
}

/** The model only returns IDs: all business words are retrieved from the immutable source. */
export function planReportSemantics(
	dataset: AuditReportDataset,
	draft: ReportDraft,
	policy: SemanticPolicy,
): SemanticState {
	const state: SemanticState = { policy, jobs: [] };
	if (draft.status === "needs-input") return state;
	const paragraphs = semanticParagraphs(draft);
	const historyParagraphIds = paragraphs
		.filter((p) => ["turnover-historical-findings", "regular-previous-rectification"].includes(p.paragraphId))
		.map((p) => p.paragraphId);
	if (historyParagraphIds.length) {
		const comparison = comparePreviousAuditFindings(dataset.findings);
		state.ruleMatchedPreviousIds = [...new Set(comparison.unrectified.map((pair) => pair.previous.findingId))];
		for (const previous of comparison.previousFindings) {
			if (!comparison.needsReview.some((pair) => pair.previous.findingId === previous.findingId)) continue;
			const records = [previous, ...comparison.currentFindings];
			state.jobs.push({
				id: `compare:${previous.findingId}`,
				kind: "compare",
				previousTitle: previous.title,
				comparisonRule:
					"首个atom为历史问题，其余为本次全部问题。一次提交comparisons，每个本次ID恰好一次。每项包含sameProblem、rationale、previousFactQuote、currentFactQuote和identity。identity含previousObject/currentObject/previousFailure/currentFailure（分别摘取两侧引用中的具体对象及缺陷连续原文，至少4字符），objectRelation/failureRelation分别为same/different/insufficient。比较具体业务对象与应履行但未履行的动作，不能上提为公示、合规、管理等大类。failureRelation必须比较各自应满足的控制要求、实际偏差及方向；共同字段、流程或问题标题相同不等于违反同一要求。引用必须保留能区分要求的限定语，rationale分别说明两侧要求及其是否相同，不能以一句‘均为设置错误’替代。例如未按已批准值准确录入与低于政策下限属于不同控制要求；迟延完成与根本未执行应比较具体履行义务，不单按程度差异判为不同。对象或缺陷任一different则false；两者均same才true；其余不足以作确定判断。新发生的姓名、客户、日期不同不等于控制缺陷不同；但人员变更后的更新义务与某项业务信息的首次公示义务不能只因都属公示而认同。复合问题有具体子项重叠可匹配，引用并解释该子项。不得遗漏不匹配项，允许一对多。",
				reason: "unresolved-previous-finding",
				paragraphIds: historyParagraphIds,
				atoms: records.map((f) => ({
					id: f.findingId,
					text: JSON.stringify({
						title: f.title,
						category: f.category,
						subcategory: f.subcategory,
						policyBasis: f.policyBasis,
						factText: f.factText,
						internalSubitems: f.internalSubitems,
					}),
				})),
				evidenceIds: [...new Set(records.flatMap((f) => f.evidenceIds))],
				status: "pending",
				attempts: 0,
				errors: [],
			});
		}
	}
	if (!policy.enabled) return state;
	const current = dataset.findings.filter(
		(f) =>
			!f.isHistorical && f.projectId === dataset.task.projectId && f.organizationId === dataset.task.organizationId,
	);
	for (const finding of current) {
		const targets = paragraphs.filter(
			(p) =>
				p.paragraphId === `finding-${finding.findingId}-fact` ||
				p.paragraphId === `attachment-finding-${finding.findingId}-fact`,
		);
		const text = targets[0]?.text;
		if (!text || /\n|(?:一是|二是|（一）|（二）)/u.test(text) || finding.internalSubitems?.length) continue;
		const atoms = organizationAtoms(text);
		if (atoms.length < 2) continue;
		if (targets.some((p) => p.text !== text)) continue;
		state.jobs.push({
			id: `organize:${finding.findingId}`,
			kind: "organize",
			reason: "explicit-business-boundaries",
			paragraphIds: targets.map((p) => p.paragraphId),
			atoms,
			evidenceIds: [...finding.evidenceIds],
			status: "pending",
			attempts: 0,
			errors: [],
		});
	}
	const summaries = [
		{ id: "regular-opinion-summary", findings: current },
		{ id: "turnover-conclusion", findings: current },
		{ id: "attachment-aml-opinion-summary", findings: current.filter((f) => f.category === "反洗钱工作") },
	];
	for (const item of summaries) {
		const hasMajor = item.findings.some((f) => f.severity === "重大" || f.majorConfirmed === true);
		if (
			!paragraphs.some((p) => p.paragraphId === item.id) ||
			(item.findings.length < policy.summaryFindingThreshold && !hasMajor)
		)
			continue;
		state.jobs.push({
			id: `summary:${item.id}`,
			kind: "summary",
			reason: hasMajor ? "recorded-major-finding" : "many-findings",
			paragraphIds: [item.id],
			atoms: item.findings.map((f) => ({
				id: f.findingId,
				text: f.title,
				category: f.category,
				major: f.severity === "重大" || f.majorConfirmed === true,
			})),
			evidenceIds: [...new Set(item.findings.flatMap((f) => f.evidenceIds))],
			status: "pending",
			attempts: 0,
			errors: [],
		});
	}
	const majorParagraph = paragraphs.find((p) => p.paragraphId === "attachment-aml-opinion-summary");
	if (majorParagraph && dataset.aml?.majorMatters.some((m) => m.confirmedMajor)) {
		const atoms = organizationAtoms(majorParagraph.text);
		if (atoms.length > 1)
			state.jobs.push({
				id: "organize:aml-major-summary",
				kind: "organize",
				reason: "recorded-major-matter",
				paragraphIds: [majorParagraph.paragraphId],
				atoms,
				evidenceIds: [...majorParagraph.evidenceIds],
				status: "pending",
				attempts: 0,
				errors: [],
			});
	}
	return state;
}

const ProposalSchema = Type.Object(
	{ groups: Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { minItems: 1 }) },
	{ additionalProperties: false },
);
const ComparisonItemSchema = Type.Object(
	{
		currentFindingId: Type.String({ minLength: 1 }),
		sameProblem: Type.Boolean(),
		rationale: Type.String({ minLength: 10, maxLength: 2000 }),
		previousFactQuote: Type.String({ minLength: 8 }),
		currentFactQuote: Type.String({ minLength: 8 }),
		identity: Type.Object(
			{
				previousObject: Type.String({ minLength: 4 }),
				currentObject: Type.String({ minLength: 4 }),
				previousFailure: Type.String({ minLength: 4 }),
				currentFailure: Type.String({ minLength: 4 }),
				objectRelation: Type.Union([Type.Literal("same"), Type.Literal("different"), Type.Literal("insufficient")]),
				failureRelation: Type.Union([
					Type.Literal("same"),
					Type.Literal("different"),
					Type.Literal("insufficient"),
				]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const ComparisonSchema = Type.Object(
	{ comparisons: Type.Array(ComparisonItemSchema, { minItems: 1 }) },
	{ additionalProperties: false },
);

/** No wording, numbering, citations or severity supplied by a model are accepted. */
export function submitReportSemantics(
	state: SemanticState,
	id: string,
	proposal: unknown,
	dataset: AuditReportDataset,
): SemanticJob {
	const job = state.jobs.find((item) => item.id === id);
	if (!job || job.status !== "pending") throw new Error("Unknown or finished semantic job");
	const errors: string[] = [];
	if (job.kind === "compare") {
		if (!Value.Check(ComparisonSchema, proposal))
			errors.push(
				"Submit {comparisons:[{currentFindingId,sameProblem,rationale,previousFactQuote,currentFactQuote,identity:{previousObject,currentObject,previousFailure,currentFailure,objectRelation,failureRelation}}]}; relations are same/different/insufficient; include every current finding exactly once",
			);
		else {
			const expected = job.atoms.slice(1).map((atom) => atom.id);
			const received = proposal.comparisons.map((row) => row.currentFindingId);
			const missing = expected.filter((id) => !received.includes(id));
			const unknown = received.filter((id) => !expected.includes(id));
			const duplicates = [...new Set(received.filter((id, index) => received.indexOf(id) !== index))];
			if (missing.length || unknown.length || duplicates.length)
				errors.push(
					`Every current finding must occur exactly once. Resubmit the complete array; missing=${JSON.stringify(missing)}, unknown=${JSON.stringify(unknown)}, duplicates=${JSON.stringify(duplicates)}`,
				);
		}
		// Protocol repairs do not consume evidence-judgment attempts. Both budgets remain bounded.
		if (errors.length) {
			job.repairAttempts = (job.repairAttempts ?? 0) + 1;
			job.errors = errors;
			if (job.repairAttempts >= state.policy.maxAttempts) job.status = "failed";
			return job;
		}
		if (!Value.Check(ComparisonSchema, proposal)) throw new Error("Comparison schema validation invariant failed");
		job.attempts++;
		if (
			!job.evidenceIds.length ||
			job.evidenceIds.some((id) => !dataset.evidence.some((e) => e.evidenceId === id)) ||
			job.atoms.some((atom) => {
				const record = dataset.findings.find((f) => f.findingId === atom.id);
				return (
					!record?.evidenceIds.length ||
					record.evidenceIds.some((id) => !dataset.evidence.some((e) => e.evidenceId === id))
				);
			})
		)
			errors.push("Source evidence missing");
		else if (
			!proposal.comparisons.every((row) =>
				[row.previousFactQuote, row.currentFactQuote].every((quote, index) => {
					const ids = [job.atoms[0]!.id, row.currentFindingId];
					const record = dataset.findings.find((f) => f.findingId === ids[index]);
					if (!record) return false;
					const other = dataset.findings.find((f) => f.findingId === ids[1 - index]);
					const policyText = record.policyBasis.trim() || other?.policyBasis.trim();
					const text = record.factText.trim();
					const fact = policyText && text.startsWith(policyText) ? text.slice(policyText.length) : text;
					return (
						[fact, ...(record.internalSubitems ?? [])].some(
							(part) => !isTitleOnlyFact(part, record.title) && part.includes(quote),
						) &&
						!isTitleOnlyFact(quote, record.title) &&
						!policyText?.includes(quote) &&
						quote !== record.title
					);
				}),
			)
		)
			errors.push("Comparison quotes must occur verbatim in the corresponding original fact or subitem");
		else if (
			proposal.comparisons.some((row) => {
				const i = row.identity;
				const quoted =
					row.previousFactQuote.includes(i.previousObject) &&
					row.previousFactQuote.includes(i.previousFailure) &&
					row.currentFactQuote.includes(i.currentObject) &&
					row.currentFactQuote.includes(i.currentFailure);
				const different = i.objectRelation === "different" || i.failureRelation === "different";
				const same = i.objectRelation === "same" && i.failureRelation === "same";
				return !quoted || (!different && !same) || row.sameProblem !== same;
			})
		)
			errors.push(
				"Identity phrases must be verbatim in their respective fact quotes; sameProblem requires both relations same, any different requires false, unresolved identity cannot be certified",
			);
		else {
			job.comparisons = proposal.comparisons;
			job.decision = {
				sameProblem: proposal.comparisons.some((row) => row.sameProblem),
				rationale: "批量比较完成，逐项理由保留在comparisons中。",
			};
			const previous = dataset.findings.find((f) => f.findingId === job.atoms[0]?.id)!;
			job.text = job.decision.sameProblem
				? `“${previous.title}”问题在本次审计中仍然存在，未有效整改。`
				: `上次“${previous.title}”中涉及的具体事项，本次未再发现同类情形。`;
			job.status = "accepted";
		}
		job.errors = errors;
		if (errors.length && job.attempts >= state.policy.maxAttempts) job.status = "failed";
		return job;
	}
	job.attempts++;
	if (!Value.Check(ProposalSchema, proposal)) errors.push("Expected only groups of source atom IDs");
	else {
		const ids = proposal.groups.flat();
		const expected = job.atoms.map((atom) => atom.id);
		if (
			ids.length !== expected.length ||
			new Set(ids).size !== ids.length ||
			expected.some((id) => !ids.includes(id))
		)
			errors.push("Every source atom must occur exactly once");
		if (job.kind === "organize" && ids.join("\0") !== expected.join("\0"))
			errors.push("Source order must be preserved, including conditions and negations");
		const byId = new Map(job.atoms.map((atom) => [atom.id, atom]));
		if (
			job.kind === "summary" &&
			proposal.groups.some((group) => new Set(group.map((id) => byId.get(id)?.category)).size !== 1)
		)
			errors.push("Do not group different business categories together");
		const evidence = new Set(dataset.evidence.map((e) => e.evidenceId));
		if (!job.evidenceIds.length || job.evidenceIds.some((id) => !evidence.has(id)))
			errors.push("Source evidence missing");
		if (!errors.length) {
			job.text =
				job.kind === "organize"
					? proposal.groups.map((group) => group.map((id) => byId.get(id)!.text).join("")).join("\n")
					: proposal.groups
							.map((group) => {
								const atoms = group.map((id) => byId.get(id)!);
								return atoms[0]!.category!;
							})
							.filter((category, index, values) => values.indexOf(category) === index)
							.join("、");
			job.status = "accepted";
		}
	}
	job.errors = errors;
	if (errors.length && job.attempts >= state.policy.maxAttempts) job.status = "retained";
	return job;
}

export function applyReportSemantics(draft: ReportDraft, state: SemanticState): ReportDraft {
	if (state.jobs.some((j) => j.kind === "compare" && j.status !== "accepted"))
		throw new Error("Historical comparison is unresolved; report delivery is blocked");
	const result = structuredClone(draft);
	const accepted = state.jobs.filter((item) => item.status === "accepted");
	// Organize a conclusion before appending its summary when both jobs target that paragraph.
	for (const job of [
		...accepted.filter((item) => item.kind === "organize"),
		...accepted.filter((item) => item.kind === "summary"),
	]) {
		for (const p of semanticParagraphs(result).filter((p) => job.paragraphIds.includes(p.paragraphId))) {
			if (job.kind === "organize") p.text = job.text!;
			else if (!job.atoms.every((atom) => p.text.includes(atom.category!)))
				p.text += `本次发现的问题主要涉及${job.text}。`;
			p.evidenceIds = [...new Set([...p.evidenceIds, ...job.evidenceIds])];
		}
	}
	// A negative pair says nothing about other current findings. Aggregate only after ALL pairs finish.
	const comparisons = accepted.filter((job) => job.kind === "compare");
	const summaries: { title: string; sameProblem: boolean }[] = [];
	for (const previousId of new Set(comparisons.map((job) => job.atoms[0]!.id))) {
		const jobs = comparisons.filter((job) => job.atoms[0]!.id === previousId);
		const positive = jobs.find((job) => job.decision?.sameProblem);
		const ruleMatched = state.ruleMatchedPreviousIds?.includes(previousId);
		const selected = (positive ?? jobs[0])!;
		if (!ruleMatched && selected.previousTitle)
			summaries.push({ title: selected.previousTitle, sameProblem: Boolean(positive) });
		for (const p of semanticParagraphs(result).filter((p) =>
			jobs.some((job) => job.paragraphIds.includes(p.paragraphId)),
		)) {
			if (!ruleMatched && !selected.previousTitle) p.text += selected.text!;
			p.evidenceIds = [...new Set([...p.evidenceIds, ...jobs.flatMap((job) => job.evidenceIds)])];
		}
	}
	for (const p of semanticParagraphs(result).filter((p) =>
		comparisons.some((job) => job.paragraphIds.includes(p.paragraphId)),
	)) {
		const titles = summaries.filter((row) => row.sameProblem).map((row) => `“${row.title}”`);
		if (titles.length) {
			// Keep one title inventory and one conclusion; pair-level negatives remain in the jobs.
			const conclusion = `${titles.join("、")}问题在本次审计中仍然存在，未有效整改。`;
			p.text = p.text.endsWith("未有效整改。")
				? `${p.text.slice(0, -1)}；${conclusion}`
				: `${p.text}其中，${conclusion}`;
		} else if (!state.ruleMatchedPreviousIds?.length && summaries.some((row) => !row.sameProblem)) {
			// No match in a finding list does not prove actual rectification or complete audit coverage.
			p.text += "本次问题列表中未匹配到上述历史问题的同类事项。";
		}
	}
	const positiveJobs = comparisons.filter((job) => job.decision?.sameProblem);
	if (positiveJobs.length && !state.ruleMatchedPreviousIds?.length) {
		for (const p of semanticParagraphs(result).filter((p) => p.paragraphId === "turnover-conclusion")) {
			p.text += "本次比对发现，上次审计中的部分问题仍未有效整改。";
			p.evidenceIds = [...new Set([...p.evidenceIds, ...positiveJobs.flatMap((job) => job.evidenceIds)])];
		}
	}
	return result;
}
