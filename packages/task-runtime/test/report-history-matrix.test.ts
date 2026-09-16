import { describe, expect, it } from "vitest";
import { evaluateComparisonLabels } from "../src/audit-report/report-comparison-evaluation.ts";
import type { AuditFinding, AuditReportDataset, ReportDraft } from "../src/audit-report/report-contracts.ts";
import { comparePreviousAuditFindings } from "../src/audit-report/report-pipeline.ts";
import {
	applyReportSemantics,
	planReportSemantics,
	submitReportSemantics as submitRaw,
} from "../src/audit-report/report-semantic.ts";

// Transport/aggregation tests declare their semantic premises; they are not an accuracy oracle.
const submitReportSemantics: typeof submitRaw = (state, id, proposal, dataset) => {
	const value = proposal as {
		comparisons?: Array<{ previousFactQuote: string; currentFactQuote: string; sameProblem: boolean }>;
	} | null;
	if (!value?.comparisons) return submitRaw(state, id, proposal, dataset);
	return submitRaw(
		state,
		id,
		{
			comparisons: value.comparisons.map((row) => ({
				...row,
				identity: {
					previousObject: row.previousFactQuote,
					currentObject: row.currentFactQuote,
					previousFailure: row.previousFactQuote,
					currentFailure: row.currentFactQuote,
					objectRelation: row.sameProblem ? "same" : "different",
					failureRelation: "same",
				},
			})),
		},
		dataset,
	);
};

function finding(id: string, historical: boolean, factText: string): AuditFinding {
	return {
		findingId: id,
		isHistorical: historical,
		projectId: "P",
		organizationId: "O",
		category: "综合管理",
		subcategory: "信息公示",
		title: "信息公示不完整",
		policyBasis: "应完整公示业务及人员信息。",
		factText,
		internalSubitems: [],
		evidenceIds: [id],
	} as unknown as AuditFinding;
}
const policy = { enabled: false, maxAttempts: 2, summaryFindingThreshold: 8 };
function scenario() {
	const findings = [
		finding("H", true, "经纪人员姓名没有公示。"),
		finding("C1", false, "融资融券收费标准缺失。"),
		finding("C2", false, "本次仍未公示经纪人员姓名。"),
	];
	const dataset = {
		task: { projectId: "P", organizationId: "O" },
		findings,
		evidence: findings.map((f) => ({ evidenceId: f.findingId })),
	} as unknown as AuditReportDataset;
	const draft = {
		status: "ready-for-review",
		introduction: { paragraphId: "intro", text: "引言", evidenceIds: [] },
		sections: [
			{
				paragraphs: [
					{ paragraphId: "turnover-historical-findings", text: "历史问题：信息公示不完整。", evidenceIds: ["H"] },
				],
				tables: [],
				subsections: [],
			},
		],
	} as unknown as ReportDraft;
	return { dataset, draft };
}

describe("historical finding matrix", () => {
	it.each(["regular", "consultation", "turnover"])(
		"uses batch comparisons for %s and writes back to its actual paragraph",
		(type) => {
			const { dataset, draft } = scenario();
			const id = type === "turnover" ? "turnover-historical-findings" : "regular-previous-rectification";
			draft.sections[0]!.paragraphs[0]!.paragraphId = id;
			const state = planReportSemantics(dataset, draft, policy);
			expect(state.jobs).toHaveLength(1);
			expect(state.jobs[0]!.paragraphIds).toEqual([id]);
			expect(() => applyReportSemantics(draft, state)).toThrow("unresolved");
			submitReportSemantics(
				state,
				state.jobs[0]!.id,
				{
					comparisons: state.jobs[0]!.atoms.slice(1).map((atom) => ({
						currentFindingId: atom.id,
						sameProblem: atom.id === "C2",
						rationale: "按具体人员公示对象与缺陷完成比较。",
						previousFactQuote: dataset.findings[0]!.factText,
						currentFactQuote: dataset.findings.find((f) => f.findingId === atom.id)!.factText,
					})),
				},
				dataset,
			);
			const paragraph = applyReportSemantics(draft, state).sections[0]!.paragraphs[0]!;
			expect(paragraph.text).toContain("未有效整改");
			expect(paragraph.evidenceIds).toEqual(expect.arrayContaining(["H", "C1", "C2"]));
		},
	);
	it("an empty current list alone cannot certify that historical findings were rectified", () => {
		const { dataset } = scenario();
		dataset.findings = dataset.findings.filter((finding) => finding.isHistorical);
		expect(comparePreviousAuditFindings(dataset.findings).rectified).toEqual([]);
	});
	it.each(["different", "insufficient"])(
		"rejects a positive decision with %s identity despite valid quotes",
		(relation) => {
			const { dataset, draft } = scenario();
			const state = planReportSemantics(dataset, draft, policy);
			const job = state.jobs[0]!;
			const comparisons = job.atoms.slice(1).map((atom) => ({
				currentFindingId: atom.id,
				sameProblem: true,
				rationale: "引用虽然真实，但具体公示对象并不相同。",
				previousFactQuote: dataset.findings[0]!.factText,
				currentFactQuote: dataset.findings.find((f) => f.findingId === atom.id)!.factText,
				identity: {
					previousObject: "经纪人员姓名",
					currentObject: atom.id === "C1" ? "融资融券收费标准" : "经纪人员姓名",
					previousFailure: "没有公示",
					currentFailure: atom.id === "C1" ? "收费标准缺失" : "未公示经纪人员姓名",
					objectRelation: relation,
					failureRelation: "same",
				},
			}));
			expect(submitRaw(state, job.id, { comparisons }, dataset).status).toBe("pending");
			expect(() => applyReportSemantics(draft, state)).toThrow("unresolved");
		},
	);
	it("groups multiple historical conclusions without losing source citations", () => {
		const { dataset, draft } = scenario();
		const extra = finding("H2", true, "上次业务收费标准未公示。");
		extra.title = "收费公示不完整";
		dataset.findings = [...dataset.findings, extra];
		dataset.evidence = [...dataset.evidence, { evidenceId: "H2" } as AuditReportDataset["evidence"][number]];
		const state = planReportSemantics(dataset, draft, policy);
		for (const job of state.jobs) {
			submitReportSemantics(
				state,
				job.id,
				{
					comparisons: job.atoms.slice(1).map((atom) => ({
						currentFindingId: atom.id,
						sameProblem: true,
						rationale: "按具体公示事项完成两期问题比较。",
						previousFactQuote: dataset.findings.find((f) => f.findingId === job.atoms[0]!.id)!.factText,
						currentFactQuote: dataset.findings.find((f) => f.findingId === atom.id)!.factText,
					})),
				},
				dataset,
			);
		}
		const paragraph = applyReportSemantics(draft, state).sections[0]!.paragraphs[0]!;
		expect(paragraph.text.match(/未有效整改/gu)).toHaveLength(1);
		expect(paragraph.text).toContain("“信息公示不完整”、“收费公示不完整”");
		expect(paragraph.evidenceIds).toEqual(expect.arrayContaining(["H", "H2", "C1", "C2"]));
	});
	it("rejects matching and model quotes based only on a wrapped title", () => {
		const { dataset, draft } = scenario();
		for (const row of dataset.findings) row.factText = `上一次审计发现，营业部存在“${row.title}”问题。`;
		expect(comparePreviousAuditFindings(dataset.findings).unrectified).toEqual([]);
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		const result = submitReportSemantics(
			state,
			job.id,
			{
				comparisons: job.atoms.slice(1).map((atom) => ({
					currentFindingId: atom.id,
					sameProblem: true,
					rationale: "两条记录使用相同标题，模型声称相同。",
					previousFactQuote: dataset.findings[0]!.factText,
					currentFactQuote: dataset.findings[0]!.factText,
				})),
			},
			dataset,
		);
		expect(result.status).toBe("pending");
		expect(result.errors).toContain(
			"Comparison quotes must occur verbatim in the corresponding original fact or subitem",
		);
	});
	it("20 historical records and 30 current records create 20 complete batches", () => {
		const { dataset, draft } = scenario();
		dataset.findings = [
			...Array.from({ length: 20 }, (_, i) => finding(`H${i}`, true, `历史人员公示问题${i}。`)),
			...Array.from({ length: 30 }, (_, i) => finding(`C${i}`, false, `本次业务公示问题${i}。`)),
		];
		const state = planReportSemantics(dataset, draft, policy);
		expect(state.jobs).toHaveLength(20);
		expect(state.jobs.every((job) => job.atoms.length === 31)).toBe(true);
	});
	it.each(["omit", "duplicate", "unknown", "none", "multiple"])("validates batch completeness: %s", (mode) => {
		const { dataset, draft } = scenario();
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		const comparisons = job.atoms.slice(1).map((atom) => ({
			currentFindingId: atom.id,
			sameProblem: mode === "multiple",
			rationale: "按人员信息与业务收费的具体事实进行比较。",
			previousFactQuote: dataset.findings[0]!.factText,
			currentFactQuote: dataset.findings.find((f) => f.findingId === atom.id)!.factText,
		}));
		if (mode === "omit") comparisons.pop();
		if (mode === "duplicate") comparisons[1] = comparisons[0]!;
		if (mode === "unknown") comparisons[1]!.currentFindingId = "UNKNOWN";
		const accepted = ["none", "multiple"].includes(mode);
		expect(submitReportSemantics(state, job.id, { comparisons }, dataset).status).toBe(
			accepted ? "accepted" : "pending",
		);
		if (accepted)
			expect(applyReportSemantics(draft, state).sections[0]!.paragraphs[0]!.text).toContain(
				mode === "none" ? "未再发现" : "未有效整改",
			);
	});
	it("same headings and policy cannot override different facts", () => {
		const { dataset } = scenario();
		const result = comparePreviousAuditFindings(dataset.findings);
		expect(result.unrectified).toEqual([]);
		expect(result.needsReview).toHaveLength(2);
		expect(result.rectified).toEqual([]);
		expect(result.newFindings).toEqual([]);
	});
	it("retains low-similarity and cross-category pairs, independent of order", () => {
		const { dataset } = scenario();
		dataset.findings = dataset.findings.map((row, index) =>
			index === 1 ? { ...row, category: "其他", title: "全新表述", subcategory: "其他" } : row,
		);
		const pairs = (rows: readonly AuditFinding[]) =>
			comparePreviousAuditFindings(rows)
				.needsReview.map((p) => `${p.previous.findingId}:${p.current.findingId}`)
				.sort();
		expect(pairs(dataset.findings)).toEqual(["H:C1", "H:C2"]);
		expect(pairs([...dataset.findings].reverse())).toEqual(pairs(dataset.findings));
	});
	it("supports many-to-many without reserving a current finding", () => {
		const { dataset } = scenario();
		dataset.findings = [...dataset.findings, finding("H2", true, "上次部分业务收费未展示。")];
		expect(comparePreviousAuditFindings(dataset.findings).needsReview).toHaveLength(4);
	});
	it.each([false, true])(
		"aggregates mixed decisions without contradictory or duplicate conclusions, reverse=%s",
		(reverse) => {
			const { dataset, draft } = scenario();
			const state = planReportSemantics(dataset, draft, policy);
			const jobs = reverse ? [...state.jobs].reverse() : state.jobs;
			for (const job of jobs) {
				submitReportSemantics(
					state,
					job.id,
					{
						comparisons: job.atoms.slice(1).map((atom) => ({
							currentFindingId: atom.id,
							sameProblem: atom.id === "C2",
							rationale: "比较具体缺陷对象，人员信息不同于业务收费。",
							previousFactQuote: dataset.findings[0]!.factText,
							currentFactQuote: dataset.findings.find((f) => f.findingId === atom.id)!.factText,
						})),
					},
					dataset,
				);
			}
			const text = applyReportSemantics(draft, state).sections[0]!.paragraphs[0]!.text;
			expect(text.match(/未有效整改/gu)).toHaveLength(1);
			expect(text).not.toContain("未再发现");
		},
	);
	it("requires every pair to finish, even when one has already matched", () => {
		const { dataset, draft } = scenario();
		const state = planReportSemantics(dataset, draft, policy);
		expect(() => applyReportSemantics(draft, state)).toThrow("unresolved");
	});
	it("does not accept citations from only one side", () => {
		const { dataset, draft } = scenario();
		dataset.findings[0]!.evidenceIds = [];
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		expect(
			submitReportSemantics(
				state,
				job.id,
				{
					comparisons: job.atoms.slice(1).map((atom) => ({
						currentFindingId: atom.id,
						sameProblem: false,
						rationale: "两期缺陷对象不同，分别为人员与收费。",
						previousFactQuote: dataset.findings[0]!.factText,
						currentFactQuote: dataset.findings.find((f) => f.findingId === atom.id)!.factText,
					})),
				},
				dataset,
			).errors,
		).toContain("Source evidence missing");
	});
	it("exact complete facts can match multiple rows but empty facts cannot", () => {
		const text = "业务台账缺少经办人员签字。";
		const rows = [
			finding("H1", true, text),
			finding("H2", true, text),
			finding("C1", false, text),
			finding("C2", false, text),
		];
		expect(comparePreviousAuditFindings(rows).unrectified).toHaveLength(4);
		rows.forEach((row) => {
			row.factText = "";
		});
		expect(comparePreviousAuditFindings(rows).unrectified).toEqual([]);
	});
	it("independent labels catch a confidently wrong decision, omissions and duplicates", () => {
		// Authored answer: personnel disclosure and fee disclosure are different defects.
		const labels = [
			{ previousId: "H", currentId: "C1", sameProblem: false },
			{ previousId: "H", currentId: "C2", sameProblem: true },
		];
		expect(evaluateComparisonLabels(labels, labels).accepted).toBe(true);
		expect(
			evaluateComparisonLabels(
				labels,
				labels.map((row) => ({ ...row, sameProblem: true })),
			).passed,
		).toBe(1);
		expect(evaluateComparisonLabels(labels, labels.slice(1)).accepted).toBe(false);
		expect(evaluateComparisonLabels(labels, [...labels, labels[0]!]).accepted).toBe(false);
		expect(() => evaluateComparisonLabels([], [])).toThrow();
	});
});
