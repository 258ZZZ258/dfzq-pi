import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuditReportDataset, ReportClaimVerification } from "./report-contracts.ts";

const ReviewSchema = Type.Object(
	{
		schemaVersion: Type.Literal("audit-history-review.v1"),
		inputFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
		reviewer: Type.String({ minLength: 1 }),
		method: Type.Union([Type.Literal("independent-model"), Type.Literal("manual")]),
		reviewedAt: Type.String({ minLength: 1 }),
		pairs: Type.Array(
			Type.Object(
				{
					previousId: Type.String(),
					currentId: Type.String(),
					sameProblem: Type.Boolean(),
					previousQuote: Type.String({ minLength: 8 }),
					currentQuote: Type.String({ minLength: 8 }),
					rationale: Type.String({ minLength: 10 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

/** The evaluation caller supplies an independently obtained review, never generation state.
 * This fingerprint binds its facts and source versions; it does not authenticate the reviewer. */
export function historicalReviewFingerprint(dataset: AuditReportDataset): string {
	const findings = dataset.findings.slice().sort((a, b) => a.findingId.localeCompare(b.findingId));
	const ids = new Set(findings.flatMap((f) => f.evidenceIds));
	return createHash("sha256")
		.update(
			JSON.stringify({
				task: dataset.task,
				findings,
				evidence: dataset.evidence
					.filter(
						(e) =>
							ids.has(e.evidenceId) ||
							["queryReturnedRecordCount", "previousQueryReturnedRecordCount"].includes(e.sourceField),
					)
					.map(({ queryTime: _queryTime, ...record }) => record)
					.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
			}),
		)
		.digest("hex");
}

export function verifyHistoricalJudgment(
	dataset: AuditReportDataset,
	input: { location: string; text: string; evidenceIds: readonly string[] },
	review: unknown,
): ReportClaimVerification | undefined {
	if (
		!/paragraph\[(?:turnover-historical-findings|regular-previous-rectification|turnover-conclusion)\]/u.test(
			input.location,
		) ||
		!/(?:未.*整改|已整改|未再发现|仍然存在|未匹配到)/u.test(input.text)
	)
		return undefined;
	const errors: string[] = [];
	const previous = dataset.findings.filter((f) => f.isHistorical);
	const current = dataset.findings.filter((f) => !f.isHistorical);
	const previousProjects = new Set(previous.map((f) => f.projectId));
	if (
		previousProjects.size !== 1 ||
		previousProjects.has(dataset.task.projectId) ||
		new Set(dataset.findings.map((f) => f.findingId)).size !== dataset.findings.length
	)
		errors.push("历史项目范围或问题ID不唯一");
	for (const [field, rows, projectId] of [
		["previousQueryReturnedRecordCount", previous, previous[0]?.projectId],
		["queryReturnedRecordCount", current, dataset.task.projectId],
	] as const) {
		const counts = dataset.evidence.filter((e) => e.sourceId === "DS-03" && e.sourceField === field);
		if (
			counts.length !== 1 ||
			!counts[0]?.dataVersion ||
			counts[0].sourceRecordId !== projectId ||
			counts[0].rawValue !== String(rows.length) ||
			counts[0].normalizedValue !== String(rows.length)
		)
			errors.push("问题清单与原始查询范围或返回数量不一致");
	}
	const proofs = dataset.evidence.filter(
		(e) =>
			dataset.findings.some((f) => f.findingId === e.sourceRecordId && f.evidenceIds.includes(e.evidenceId)) &&
			e.sourceId === "DS-03" &&
			["title", "factText"].includes(e.sourceField),
	);
	const positive = new Set<string>();
	if (!Value.Check(ReviewSchema, review)) errors.push("缺少独立核验结果或格式不符");
	else {
		if (review.inputFingerprint !== historicalReviewFingerprint(dataset)) errors.push("独立核验输入版本不一致");
		if (!Number.isFinite(Date.parse(review.reviewedAt))) errors.push("独立核验日期无效");
		const keys = new Set<string>();
		for (const pair of review.pairs) {
			const a = previous.find((f) => f.findingId === pair.previousId);
			const b = current.find((f) => f.findingId === pair.currentId);
			const key = JSON.stringify([pair.previousId, pair.currentId]);
			if (!a || !b || keys.has(key)) errors.push("独立核验存在未知或重复问题对");
			keys.add(key);
			if (
				!a?.factText.includes(pair.previousQuote) ||
				!b?.factText.includes(pair.currentQuote) ||
				pair.previousQuote === a?.title ||
				pair.currentQuote === b?.title
			)
				errors.push("独立核验引用不在对应原始事实中");
			if (pair.sameProblem) positive.add(pair.previousId);
		}
		if (
			!previous.length ||
			!current.length ||
			keys.size !== previous.length * current.length ||
			previous.some((a) => current.some((b) => !keys.has(JSON.stringify([a.findingId, b.findingId]))))
		)
			errors.push("独立核验未完整覆盖两期问题组合");
	}
	for (const f of dataset.findings) {
		if (
			f.organizationId !== dataset.task.organizationId ||
			(!f.isHistorical && f.projectId !== dataset.task.projectId)
		)
			errors.push("问题不属于当前任务机构或项目");
		for (const field of ["title", "factText"] as const) {
			const values = proofs.filter((e) => e.sourceRecordId === f.findingId && e.sourceField === field);
			if (
				values.length !== 1 ||
				!values[0]?.dataVersion ||
				values[0].rawValue !== f[field] ||
				values[0].normalizedValue !== f[field]
			)
				errors.push("原始问题字段或段落依据不一致");
		}
	}
	let textMatches = false;
	const referencedPrevious = new Set<string>();
	let negative = false;
	if (input.text === "本次比对发现，上次审计中的部分问题仍未有效整改。") {
		textMatches = positive.size > 0;
		for (const id of positive) referencedPrevious.add(id);
	} else if (input.text === "本次问题列表中未匹配到上述历史问题的同类事项。") {
		textMatches = positive.size === 0;
		negative = true;
		for (const row of previous) referencedPrevious.add(row.findingId);
	} else {
		const match = /^(?:其中，?)?(.+)问题在本次审计中仍然存在，未有效整改。$/u.exec(input.text);
		if (match) {
			const names = [...match[1]!.matchAll(/“([^”]+)”/gu)].map((m) => m[1]!);
			textMatches =
				names.length > 0 &&
				new Set(names).size === names.length &&
				names.map((name) => `“${name}”`).join("、") === match[1] &&
				names.every((name) => {
					const rows = previous.filter((f) => f.title === name);
					if (rows.length === 1) referencedPrevious.add(rows[0]!.findingId);
					return rows.length === 1 && positive.has(rows[0]!.findingId);
				});
		}
	}
	if (!textMatches) errors.push("报告判断与独立核验不一致或超出问题列表比对范围");
	const referencedRecords = new Set(referencedPrevious);
	if (Value.Check(ReviewSchema, review))
		for (const pair of review.pairs) {
			if (referencedPrevious.has(pair.previousId) && (negative || pair.sameProblem))
				referencedRecords.add(pair.currentId);
		}
	const citedProofs = proofs.filter((e) => referencedRecords.has(e.sourceRecordId));
	if (!citedProofs.length || citedProofs.some((e) => !input.evidenceIds.includes(e.evidenceId)))
		errors.push("段落没有绑定该判断所需的两期原始事实与标题依据");
	return {
		claimId: `historical-independent-review@${input.location}`,
		claimType: errors.length ? "unsupported-factual-statement" : "derived-calculation",
		claimText: input.text,
		expectedValue: "同输入版本的独立逐对核验",
		actualValue: input.text,
		value: errors.length ? 0 : 1,
		reason: errors.length
			? [...new Set(errors)].join("；")
			: "已核对独立评估、全部问题对、原文引用与段落结论；不证明实际整改完成",
		evidence: citedProofs.map((e) => ({
			...e,
			sourceName: dataset.sources.find((s) => s.sourceId === e.sourceId)?.name ?? e.sourceId,
		})),
	};
}
