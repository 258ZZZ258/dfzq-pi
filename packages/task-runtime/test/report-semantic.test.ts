import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditFinding, AuditReportDataset, ReportDraft } from "../src/audit-report/report-contracts.ts";
import {
	applyReportSemantics,
	parseSemanticPolicy,
	planReportSemantics,
	submitReportSemantics,
} from "../src/audit-report/report-semantic.ts";

const policy = { enabled: true, summaryFindingThreshold: 3, maxAttempts: 2 };
function sample(
	text = "（1）人数登记缺失。抽查2笔未填写人数。（2）对象登记缺失。另1笔未填写对象。（3）日期缺失。1笔未登记日期。",
) {
	const finding = {
		findingId: "F1",
		projectId: "P",
		organizationId: "O",
		category: "财务工作",
		title: "台账登记不完整",
		severity: "一般",
		isHistorical: false,
		evidenceIds: ["E1"],
		factText: text,
		policyBasis: "",
		internalSubitems: [],
	} as unknown as AuditFinding;
	const dataset = {
		task: { projectId: "P", organizationId: "O" },
		findings: [finding],
		evidence: [{ evidenceId: "E1" }],
	} as unknown as AuditReportDataset;
	const draft = {
		status: "ready-for-review",
		introduction: { paragraphId: "intro", text: "固定引言", evidenceIds: [] },
		sections: [
			{
				paragraphs: [{ paragraphId: "regular-opinion-summary", text: "固定评价模板。", evidenceIds: ["E1"] }],
				tables: [],
				subsections: [
					{
						paragraphs: [
							{ paragraphId: "finding-F1-fact", text, evidenceIds: ["E1"] },
							{ paragraphId: "attachment-finding-F1-fact", text, evidenceIds: ["E1"] },
						],
					},
				],
			},
		],
	} as unknown as ReportDraft;
	return { dataset, draft };
}

describe("on-demand report semantics", () => {
	it("loads the task-owned configuration", async () => {
		expect(
			parseSemanticPolicy(
				JSON.parse(await readFile(resolve("specs/audit-report/skills/semantic-policy.json"), "utf8")),
			),
		).toMatchObject({ enabled: true, maxAttempts: 2 });
		expect(() => parseSemanticPolicy({ ...policy, maxAttempts: 100 })).toThrow();
	});
	it.each(["营业部有2笔记录未登记。", "一是未登记人数。二是未登记对象。", "已分段。\n未登记人数。"])(
		"skips structured or simple details: %s",
		(text) => {
			const { dataset, draft } = sample(text);
			expect(planReportSemantics(dataset, draft, policy).jobs).toEqual([]);
		},
	);
	it("preserves every source character, number, source ID and both copies of a finding", () => {
		const { dataset, draft } = sample();
		const state = planReportSemantics(dataset, draft, policy);
		expect(state.jobs).toHaveLength(1);
		const job = state.jobs[0]!;
		submitReportSemantics(state, job.id, { groups: [["s1"], ["s2", "s3"]] }, dataset);
		expect(job.status).toBe("accepted");
		const result = applyReportSemantics(draft, state);
		const paragraphs = result.sections[0]!.subsections[0]!.paragraphs;
		expect(paragraphs[0]!.text.replaceAll("\n", "")).toBe(dataset.findings[0]!.factText);
		expect(paragraphs[0]).toMatchObject({ text: paragraphs[1]!.text, evidenceIds: ["E1"] });
		expect(result.introduction).toEqual(draft.introduction);
		expect(result.sections[0]!.paragraphs).toEqual(draft.sections[0]!.paragraphs);
		expect(draft.sections[0]!.subsections[0]!.paragraphs[0]!.text).not.toContain("\n");
	});
	it.each([
		{ groups: [["s1"], ["s2"]] },
		{ groups: [["s1"], ["s2", "s2", "s3"]] },
		{ groups: [["s2"], ["s1", "s3"]] },
		{ groups: [["s1"], ["s2", "OTHER"]] },
		{ groups: [["s1"], ["s2", "s3"]], text: "改成300笔" },
		null,
	])("rejects omissions, duplicates, changed order, invented IDs and free text: %j", (proposal) => {
		const { dataset, draft } = sample();
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		submitReportSemantics(state, job.id, proposal, dataset);
		expect(job.status).toBe("pending");
		submitReportSemantics(state, job.id, proposal, dataset);
		expect(job.status).toBe("retained");
		expect(applyReportSemantics(draft, state)).toEqual(draft);
	});
	it("skips historical, foreign-project and foreign-organization findings", () => {
		for (const patch of [{ isHistorical: true }, { projectId: "OTHER" }, { organizationId: "OTHER" }]) {
			const { dataset, draft } = sample();
			dataset.findings = [{ ...dataset.findings[0]!, ...patch }];
			expect(planReportSemantics(dataset, draft, policy).jobs).toEqual([]);
		}
	});
	it("rejects missing source evidence", () => {
		const { dataset, draft } = sample();
		dataset.evidence = [];
		const state = planReportSemantics(dataset, draft, policy);
		expect(
			submitReportSemantics(state, state.jobs[0]!.id, { groups: [["s1"], ["s2", "s3"]] }, dataset).errors,
		).toContain("Source evidence missing");
	});
	it("summarizes every finding without changing the fixed conclusion or merging issue counts", () => {
		const { dataset, draft } = sample("规范事实。");
		dataset.findings = [
			dataset.findings[0]!,
			...["F2", "F3"].map((findingId) => ({
				...dataset.findings[0]!,
				findingId,
				title: findingId === "F2" ? "报销记录缺失" : "培训记录缺失",
				category: findingId === "F2" ? "财务工作" : "综合管理",
			})),
		];
		const state = planReportSemantics(dataset, draft, policy);
		expect(state.jobs).toHaveLength(1);
		const job = state.jobs[0]!;
		expect(submitReportSemantics(state, job.id, { groups: [["F1", "F3"], ["F2"]] }, dataset).errors).toContain(
			"Do not group different business categories together",
		);
		expect(submitReportSemantics(state, job.id, { groups: [["F1", "F2"], ["F3"]] }, dataset).status).toBe("accepted");
		const result = applyReportSemantics(draft, state);
		expect(result.sections[0]!.paragraphs[0]!.text).toBe("固定评价模板。本次发现的问题主要涉及财务工作、综合管理。");
		expect(dataset.findings).toHaveLength(3);
	});
	it("triggers below the count threshold only for a recorded major finding", () => {
		const { dataset, draft } = sample("规范事实。");
		dataset.findings = [{ ...dataset.findings[0]!, severity: "重大" }];
		expect(planReportSemantics(dataset, draft, policy).jobs[0]?.reason).toBe("recorded-major-finding");
	});
	it("disabled and incomplete inputs preserve the original", () => {
		const { dataset, draft } = sample();
		expect(planReportSemantics(dataset, draft, { ...policy, enabled: false }).jobs).toEqual([]);
		expect(planReportSemantics(dataset, { ...draft, status: "needs-input" }, policy).jobs).toEqual([]);
	});
	it("preserves repeated punctuation rather than dropping source characters", () => {
		const { dataset, draft } = sample("（1）人数缺失。；抽查发现未登记。！！（2）对象缺失。另有记录缺失。");
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		expect(job.atoms.map((atom) => atom.text).join("")).toBe(dataset.findings[0]!.factText);
	});
	it("does not split a cohesive AML conclusion merely because a major matter exists", () => {
		const { dataset, draft } = sample("规范事实。");
		dataset.aml = { majorMatters: [{ confirmedMajor: true }] } as unknown as NonNullable<AuditReportDataset["aml"]>;
		draft.sections[0]!.paragraphs = [
			{
				paragraphId: "attachment-aml-opinion-summary",
				text: "已登记重大事项。原记录影响。",
				evidenceIds: ["E1"],
				requiresHumanReview: true,
			},
		];
		expect(planReportSemantics(dataset, draft, policy).jobs).toEqual([]);
		dataset.aml.majorMatters = [{ confirmedMajor: false }] as unknown as NonNullable<
			AuditReportDataset["aml"]
		>["majorMatters"];
		expect(planReportSemantics(dataset, draft, policy).jobs).toEqual([]);
	});
	it("keeps a cohesive major conclusion intact when appending the existing summary", () => {
		const { dataset, draft } = sample("规范事实。");
		dataset.findings = [{ ...dataset.findings[0]!, category: "反洗钱工作", severity: "重大" }];
		dataset.aml = { majorMatters: [{ confirmedMajor: true }] } as unknown as NonNullable<AuditReportDataset["aml"]>;
		draft.sections[0]!.paragraphs = [
			{
				paragraphId: "attachment-aml-opinion-summary",
				text: "已登记重大事项。原记录影响。",
				evidenceIds: ["E1"],
				requiresHumanReview: true,
			},
		];
		const state = planReportSemantics(dataset, draft, policy);
		expect(state.jobs).toHaveLength(1);
		for (const job of state.jobs)
			submitReportSemantics(state, job.id, { groups: job.atoms.map((atom) => [atom.id]) }, dataset);
		expect(applyReportSemantics(draft, state).sections[0]!.paragraphs[0]!.text).toBe(
			"已登记重大事项。原记录影响。本次发现的问题主要涉及反洗钱工作。",
		);
	});
	it.each([
		"抽查12笔产品销售业务，其中1笔未在《投资者确认书》中抄写确认内容；1笔未在《风险揭示书》中签字。",
		`审计发现，2名员工存在同源委托。其中1名涉及12个账户；另1名涉及18个账户。${"相关记录属于同一事项的情况说明。".repeat(15)}上述情况存在风险。`,
		"问卷内容为“（1）是否登记。（2）是否签字。”，客户未完成填写。",
	])("preserves cohesive descriptions and quoted forms regardless of length: %s", (text) => {
		const { dataset, draft } = sample(text);
		const state = planReportSemantics(dataset, draft, policy);
		expect(state.jobs).toEqual([]);
		expect(applyReportSemantics(draft, state)).toEqual(draft);
	});
	it("accepts keeping all business blocks in one paragraph as a successful decision", () => {
		const { dataset, draft } = sample();
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		expect(submitReportSemantics(state, job.id, { groups: [job.atoms.map((atom) => atom.id)] }, dataset).status).toBe(
			"accepted",
		);
		expect(job.errors).toEqual([]);
		expect(applyReportSemantics(draft, state)).toEqual(draft);
	});
	it("protects the lead-in, subitem heading and explanation as complete blocks", () => {
		const { dataset, draft } = sample(
			"审计发现以下问题：（1）会议频次不足。仅召开一次会议。（2）议事范围不完整。培训计划未审议。（3）成员调整不及时。人员变动后未更新。",
		);
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		expect(job.atoms.map((atom) => atom.text)).toEqual([
			"审计发现以下问题：（1）会议频次不足。仅召开一次会议。",
			"（2）议事范围不完整。培训计划未审议。",
			"（3）成员调整不及时。人员变动后未更新。",
		]);
		submitReportSemantics(state, job.id, { groups: job.atoms.map((atom) => [atom.id]) }, dataset);
		expect(job.status).toBe("accepted");
		expect(job.text?.split("\n")).toHaveLength(3);
	});
	it("preserves a single policy-and-fact narrative consistently without optional model layout", () => {
		const { dataset, draft } = sample(
			"公司《台账办法》规定，应完整登记。审计发现，2笔缺少人数；1笔缺少对象。上述记录尚未补齐。",
		);
		expect(planReportSemantics(dataset, draft, policy).jobs).toEqual([]);
	});
	it("does not duplicate categories already covered in the conclusion", () => {
		const { dataset, draft } = sample("规范事实。");
		dataset.findings[0]!.severity = "重大";
		draft.sections[0]!.paragraphs[0]!.text = "本次问题涉及财务工作。";
		const state = planReportSemantics(dataset, draft, policy);
		submitReportSemantics(state, state.jobs[0]!.id, { groups: [["F1"]] }, dataset);
		expect(applyReportSemantics(draft, state)).toEqual(draft);
	});
	it.each([true, false])(
		"requires an explicit historical decision and keeps its reasoning private: %s",
		(sameProblem) => {
			const { dataset, draft } = sample("本次存在甲项缺陷。");
			dataset.findings[0]!.subcategory = "台账管理";
			dataset.findings = [
				...dataset.findings,
				{
					...dataset.findings[0]!,
					findingId: "PREV",
					isHistorical: true,
					factText: "上次存在乙项问题。",
				},
			];
			draft.sections[0]!.paragraphs = [
				...draft.sections[0]!.paragraphs,
				{
					paragraphId: "turnover-historical-findings",
					text: "上次发现台账登记不完整。",
					evidenceIds: ["E1"],
					requiresHumanReview: true,
				},
			];
			const state = planReportSemantics(dataset, draft, { ...policy, enabled: false });
			const job = state.jobs[0]!;
			expect(job.kind).toBe("compare");
			expect(() => applyReportSemantics(draft, state)).toThrow("unresolved");
			submitReportSemantics(
				state,
				job.id,
				{
					comparisons: [
						{
							currentFindingId: "F1",
							sameProblem,
							rationale: "两期记录的具体事项已经逐一比较后作出判断。",
							previousFactQuote: "上次存在乙项问题。",
							currentFactQuote: "本次存在甲项缺陷。",
							identity: {
								previousObject: "乙项问题",
								currentObject: "甲项缺陷",
								previousFailure: "存在乙项问题",
								currentFailure: "存在甲项缺陷",
								objectRelation: sameProblem ? "same" : "different",
								failureRelation: "same",
							},
						},
					],
				},
				dataset,
			);
			expect(job.status).toBe("accepted");
			const result = applyReportSemantics(draft, state);
			expect(result.sections[0]!.paragraphs[1]!.text).toContain(sameProblem ? "未有效整改" : "本次未再发现");
			expect(result.sections[0]!.paragraphs[1]!.text).not.toContain("逐一比较");
		},
	);
	it("cannot deliver an unresolved historical job after invalid submissions exhaust retries", () => {
		const { dataset, draft } = sample("本次存在甲项缺陷。");
		dataset.findings[0]!.subcategory = "台账管理";
		dataset.findings = [
			...dataset.findings,
			{
				...dataset.findings[0]!,
				findingId: "PREV",
				isHistorical: true,
				factText: "上次存在乙项问题。",
			},
		];
		draft.sections[0]!.paragraphs = [
			...draft.sections[0]!.paragraphs,
			{
				paragraphId: "turnover-historical-findings",
				text: "上次问题。",
				evidenceIds: ["E1"],
				requiresHumanReview: true,
			},
		];
		const state = planReportSemantics(dataset, draft, policy);
		const job = state.jobs[0]!;
		submitReportSemantics(state, job.id, {}, dataset);
		expect(job.status).toBe("pending");
		expect(job.attempts).toBe(0);
		submitReportSemantics(state, job.id, {}, dataset);
		expect(job.status).toBe("failed");
		expect(job.repairAttempts).toBe(2);
		expect(() => applyReportSemantics(draft, state)).toThrow("unresolved");
	});
});
