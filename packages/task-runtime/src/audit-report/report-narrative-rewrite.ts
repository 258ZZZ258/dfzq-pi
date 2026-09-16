import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Source text is immutable. Candidate wording is never treated as a new data source. */
export interface NarrativeRewriteSource {
	scope: "organization-history" | "risk-event";
	paragraphId: string;
	text: string;
	evidenceIds: readonly string[];
}

export interface NarrativeRewriteFact {
	id: string;
	text: string;
}

export interface NarrativeRewriteInput extends NarrativeRewriteSource {
	sourceHash: string;
	facts: NarrativeRewriteFact[];
}

const CandidateSchema = Type.Object(
	{
		sourceHash: Type.String(),
		sentences: Type.Array(
			Type.Object(
				{
					text: Type.String({ minLength: 1, maxLength: 12000 }),
					factIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 100 },
		),
	},
	{ additionalProperties: false },
);

export interface NarrativeRewriteCandidate {
	sourceHash: string;
	candidateHash: string;
	text: string;
	sentences: Array<{ id: string; text: string; factIds: string[] }>;
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Boundaries identify coverage units, not an instruction to create new paragraphs. */
export function prepareNarrativeRewrite(source: NarrativeRewriteSource): NarrativeRewriteInput {
	if (!source.text.trim() || !source.evidenceIds.length || !source.paragraphId.trim())
		throw new Error("Narrative rewrite requires non-empty source text, paragraph and evidence");
	if (source.text.length > 30000) throw new Error("Narrative source too large; retain original instead of truncating");
	const facts = (source.text.match(/[^。！？\n]+[。！？\n]*/gu) ?? [source.text])
		.filter((text) => text.trim())
		.map((text, index) => ({ id: `f${index + 1}`, text }));
	return { ...source, evidenceIds: [...source.evidenceIds], facts, sourceHash: digest(source) };
}

// Conservative lexical guards, not semantic entailment. Keep date roles for the second-stage review.
function protectedTokens(text: string): Set<string> {
	return new Set(
		text.match(/\d+(?:[.,，]\d+)*(?:%|％)?|尚未|未记载|未完成|未获批准|不得|不代表|不等于|非真实|非公司真实制度/gu) ??
			[],
	);
}

/** Returns a review candidate, NEVER an accepted rewrite. */
export function checkNarrativeCandidate(
	input: NarrativeRewriteInput,
	proposal: unknown,
): { errors: string[]; candidate?: NarrativeRewriteCandidate } {
	const errors: string[] = [];
	const frozen = prepareNarrativeRewrite({
		scope: input.scope,
		paragraphId: input.paragraphId,
		text: input.text,
		evidenceIds: input.evidenceIds,
	});
	if (frozen.sourceHash !== input.sourceHash || !isDeepStrictEqual(frozen.facts, input.facts))
		errors.push("Source contents or fact units no longer match their frozen hash");
	if (!Value.Check(CandidateSchema, proposal)) return { errors: ["Invalid narrative candidate schema"] };
	if (proposal.sourceHash !== input.sourceHash) errors.push("Source hash mismatch");
	const facts = new Map(input.facts.map((fact) => [fact.id, fact.text]));
	const covered = new Set(proposal.sentences.flatMap((sentence) => sentence.factIds));
	if (input.facts.some((fact) => !covered.has(fact.id))) errors.push("Missing source facts");
	if ([...covered].some((id) => !facts.has(id))) errors.push("Unknown source facts");
	for (const sentence of proposal.sentences) {
		if (!sentence.text.trim() || /[\r\n]/u.test(sentence.text))
			errors.push("Each candidate sentence must be non-empty single-line prose");
		const supported = protectedTokens(sentence.factIds.map((id) => facts.get(id) ?? "").join(""));
		if ([...protectedTokens(sentence.text)].some((token) => !supported.has(token)))
			errors.push("Candidate introduces a protected value absent from its mapped facts");
	}
	for (const fact of input.facts) {
		const outputs = proposal.sentences.filter((sentence) => sentence.factIds.includes(fact.id));
		const rendered = protectedTokens(outputs.map((sentence) => sentence.text).join(""));
		if ([...protectedTokens(fact.text)].some((token) => !rendered.has(token)))
			errors.push(`Protected value or qualifier lost: ${fact.id}`);
	}
	const text = proposal.sentences.map((sentence) => sentence.text).join("");
	if (text.length > Math.max(input.text.length * 2, 500)) errors.push("Excessive narrative expansion");
	if (errors.length) return { errors: [...new Set(errors)] };
	const sentences = proposal.sentences.map((sentence, index) => ({ ...sentence, id: `s${index + 1}` }));
	return {
		errors: [],
		candidate: { sourceHash: input.sourceHash, candidateHash: digest(sentences), text, sentences },
	};
}

const ReviewSchema = Type.Object(
	{
		sourceHash: Type.String(),
		candidateHash: Type.String(),
		quality: Type.Object(
			{ noRedundantRestatement: Type.Boolean(), reason: Type.String({ minLength: 8 }) },
			{ additionalProperties: false },
		),
		facts: Type.Array(
			Type.Object(
				{ id: Type.String(), preserved: Type.Boolean(), reason: Type.String({ minLength: 8 }) },
				{ additionalProperties: false },
			),
		),
		sentences: Type.Array(
			Type.Object(
				{ id: Type.String(), supported: Type.Boolean(), reason: Type.String({ minLength: 8 }) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** Review coverage and hash binding only; caller must obtain an actual second-stage semantic review. */
export function checkNarrativeReview(
	input: NarrativeRewriteInput,
	candidate: NarrativeRewriteCandidate,
	review: unknown,
): string[] {
	if (!Value.Check(ReviewSchema, review)) return ["Invalid narrative review schema"];
	const errors: string[] = [];
	const replay = checkNarrativeCandidate(input, {
		sourceHash: candidate.sourceHash,
		sentences: candidate.sentences.map(({ text, factIds }) => ({ text, factIds })),
	});
	if (!replay.candidate || !isDeepStrictEqual(replay.candidate, candidate))
		errors.push("Candidate contents no longer match validated sentences and hash");
	if (
		candidate.sourceHash !== input.sourceHash ||
		review.sourceHash !== input.sourceHash ||
		review.candidateHash !== candidate.candidateHash
	)
		errors.push("Review does not bind this source and candidate");
	for (const [expected, actual] of [
		[input.facts.map((fact) => fact.id), review.facts.map((fact) => fact.id)],
		[candidate.sentences.map((sentence) => sentence.id), review.sentences.map((sentence) => sentence.id)],
	]) {
		if (
			!expected ||
			!actual ||
			expected.length !== actual.length ||
			new Set(actual).size !== actual.length ||
			expected.some((id) => !actual.includes(id))
		)
			errors.push("Review must cover every source fact and candidate sentence exactly once");
	}
	if (review.facts.some((fact) => !fact.preserved) || review.sentences.some((sentence) => !sentence.supported))
		errors.push("Semantic review rejected the candidate; retain original");
	if (!review.quality.noRedundantRestatement) errors.push("Narrative contains redundant restatement");
	return errors;
}
