import { expect, it } from "vitest";
import type { AuditReportDataset } from "../src/audit-report/report-contracts.ts";
import { generateReportDraft } from "../src/audit-report/report-pipeline.ts";
import { scoreStrictReportClaims } from "../src/audit-report/report-strict-rubric.ts";
import { workflowErrors } from "../src/audit-report/report-workflow.ts";

function dataset(): AuditReportDataset {
	return {
		caseId: "intro-test",
		description: "Introduction-only regression; intentionally incomplete business input",
		task: {
			taskId: "task",
			projectId: "project",
			organizationId: "branch",
			reportType: "regular",
			auditStart: "2023-07-01",
			auditEnd: "2026-04-30",
			auditGroupEstablishedMonth: "2026年6月",
			reportDate: "2026-07-01",
			templateId: "template",
			templateVersion: "1",
			closingOrganization: "审计中心",
			feedbackCompleted: false,
			workflow: { mode: "independent", matchingCompleted: true, consultationExists: false },
		},
		sources: [],
		organization: {
			organizationId: "branch",
			organizationCode: "001",
			fullName: "测试证券营业部",
			address: "测试路1号",
			areaSquareMeters: 100,
			asOf: "2026-04-30",
			evidenceIds: ["org"],
		},
		personnel: { organizationId: "branch", employeeCount: 1, brokerCount: 0, asOf: "2026-04-30", evidenceIds: [] },
		appointments: [],
		operatingMetrics: [],
		findings: [],
		riskEvents: [],
		performance: [],
		manualDecisions: [],
		evidence: [
			{
				evidenceId: "project-date",
				sourceId: "DS-03",
				sourceRecordId: "project",
				sourceField: "auditStart",
				rawValue: "2023-07-01",
				normalizedValue: "2023-07-01",
				asOf: "2026-04-30",
				queryTime: "2026-07-01T00:00:00Z",
				dataVersion: "1",
			},
			{
				evidenceId: "procedure",
				sourceId: "DS-10",
				sourceRecordId: "template",
				sourceField: "auditProcedures",
				rawValue: "程序句",
				normalizedValue: "程序句",
				asOf: "2026-04-30",
				queryTime: "2026-07-01T00:00:00Z",
				dataVersion: "1",
			},
		],
		fixedFacts: {
			auditProcedures: "实施了审核、查询、访谈、分析性复核等必要的审计程序。",
			internalControlSummary: "",
			managerDutySummary: "",
			previousRectificationSummary: "",
			historicalFindingSummary: "",
			cleanPracticeSummary: "",
		},
	};
}

it("recognizes only the exact fixed attachment scope clause, not added factual assertions", () => {
	const input = dataset();
	const draft = generateReportDraft(input);
	const claims = scoreStrictReportClaims(input, draft).sentences.flatMap((sentence) => sentence.claims);
	expect(claims.filter((claim) => claim.claimText.startsWith("检查内容主要包括"))).toEqual([]);
	const intro = draft.sections
		.flatMap((section) => section.paragraphs)
		.find((p) => p.paragraphId === "attachment-aml-introduction");
	if (!intro) throw new Error("Missing attachment introduction");
	intro.text = intro.text.replace("培训与宣传等方面", "培训与宣传等方面并检查了999笔交易");
	expect(
		scoreStrictReportClaims(input, draft)
			.sentences.flatMap((sentence) => sentence.claims)
			.some((claim) => claim.value === 0 && claim.actualValue.includes("999")),
	).toBe(true);
});

it("uses dispatched wording for the current regular introduction without inventing feedback", () => {
	const input = dataset();
	const draft = generateReportDraft(input);
	expect(draft.introduction.text).toContain("2026年6月派出审计组");
	expect(draft.introduction.text.endsWith("现出具报告如下。")).toBe(true);
	expect(draft.introduction.text).toContain(input.fixedFacts.auditProcedures);
	expect(draft.introduction.text).not.toContain("并得到了确认和反馈");
	expect(draft.introduction.evidenceIds).toContain("project-date");
	expect(draft.status).toBe("needs-input");
});

it("does not copy the body's procedure text or its evidence into the AML attachment", () => {
	const draft = generateReportDraft(dataset());
	const intro = draft.sections
		.flatMap((section) => section.paragraphs)
		.find((p) => p.paragraphId === "attachment-aml-introduction");
	expect(intro?.text).toBe(
		"按照审计工作安排，审计中心于2026年6月派出审计组，对测试证券营业部2023年7月至2026年4月期间（以下简称“审计期”）反洗钱工作进行了审计，检查内容主要包括内控机制建设、客户身份识别、客户风险分类管理、大额交易和可疑交易报告、客户身份资料和交易记录保存、培训与宣传等方面。现出具报告如下。",
	);
	expect(intro?.evidenceIds).toEqual(["project-date", "org"]);
});

it("uses the consultation template directly without regular procedures or feedback claims", () => {
	const input = dataset();
	input.task = {
		...input.task,
		reportType: "consultation",
		workflow: { mode: "consultation", matchingCompleted: false, consultationExists: false },
	};
	const draft = generateReportDraft(input);
	expect(draft.introduction.text).toBe(
		"按照审计工作安排，审计中心于2026年6月成立审计组，对你单位2023年7月至2026年4月期间（以下简称“审计期”）经营活动和内部控制的适当性、合法性和有效性等情况进行了审计。现就相关情况征求你单位意见：",
	);
	expect(draft.introduction.evidenceIds).toEqual(["project-date"]);
	input.fixedFacts.auditProcedures = "不属于征求意见书的程序内容。";
	expect(generateReportDraft(input).introduction).toEqual(draft.introduction);
});

it("does not apply the regular dispatched wording to the turnover template", () => {
	const input = dataset();
	input.task = {
		...input.task,
		reportType: "turnover",
		subjectPersonId: "person",
		subjectPersonName: "测试人员",
		workflow: { mode: "turnover", matchingCompleted: false, consultationExists: false },
	};
	expect(generateReportDraft(input).introduction.text).toContain("2026年6月成立审计组");
	expect(workflowErrors(input.task)).toEqual([]);
	expect(generateReportDraft(input).introduction.text).not.toMatch(/征求意见|确认和反馈/u);
	expect(generateReportDraft(input).blockers.some((message) => message.includes("反馈"))).toBe(false);
	input.task.feedbackCompleted = true;
	expect(generateReportDraft(input).introduction.text).not.toMatch(/征求意见|确认和反馈/u);
});

it("still blocks linked regular reports until consultation feedback and disposition are complete", () => {
	const input = dataset();
	input.task.workflow = {
		mode: "linked",
		matchingCompleted: true,
		consultationExists: true,
		sourceReportId: "consultation",
		sourceVersion: 1,
		sourceDataVersion: "snapshot",
	};
	expect(workflowErrors(input.task)).toContain("workflow: 征求意见反馈或审计处理尚未完成。");
});

it("verifies Java database record IDs through explicit object field references, not fixture IDs", () => {
	const input = dataset();
	const baseEvidence = input.evidence[0];
	if (!baseEvidence) throw new Error("Missing test evidence");
	input.evidence = [
		...input.evidence,
		{
			...baseEvidence,
			evidenceId: "org",
			sourceId: "DS-01",
			sourceRecordId: "profile-uuid",
			sourceField: "fullName",
			rawValue: input.organization.fullName,
			normalizedValue: input.organization.fullName,
		},
		{
			...baseEvidence,
			evidenceId: "staff-count",
			sourceId: "DS-02",
			sourceRecordId: "staff-snapshot-uuid",
			sourceField: "employeeCount",
			rawValue: "1",
			normalizedValue: "1",
		},
	];
	input.personnel.evidenceIds = ["staff-count"];
	const draft = generateReportDraft(input);
	const claims = scoreStrictReportClaims(input, draft).sentences.flatMap((sentence) => sentence.claims);
	for (const key of ["organization.fullName@", "personnel.employeeCount@"]) {
		const selected = claims.filter((claim) => claim.claimId.startsWith(key));
		expect(selected.length).toBeGreaterThan(0);
		expect(selected.every((claim) => claim.value === 1)).toBe(true);
	}
	input.personnel.evidenceIds = [];
	expect(
		scoreStrictReportClaims(input, draft)
			.sentences.flatMap((sentence) => sentence.claims)
			.some((claim) => claim.claimId.startsWith("personnel.employeeCount@") && claim.value === 0),
	).toBe(true);
});

it("requires both exact project dates when verifying the audit period", () => {
	const input = dataset();
	const baseEvidence = input.evidence[0];
	if (!baseEvidence) throw new Error("Missing test evidence");
	const endEvidence = {
		...baseEvidence,
		evidenceId: "project-end",
		sourceField: "auditEnd",
		rawValue: input.task.auditEnd,
		normalizedValue: input.task.auditEnd,
	};
	input.evidence = [...input.evidence, endEvidence];
	const draft = generateReportDraft(input);
	const periodClaims = () =>
		scoreStrictReportClaims(input, draft)
			.sentences.flatMap((sentence) => sentence.claims)
			.filter((claim) => claim.claimId.startsWith("task.audit-period@"));
	expect(periodClaims().length).toBeGreaterThan(0);
	expect(periodClaims().every((claim) => claim.value === 1)).toBe(true);
	for (const invalid of [
		{ ...endEvidence, sourceRecordId: "another-project" },
		{ ...endEvidence, normalizedValue: "2026-05-31", rawValue: "2026-05-31" },
		{ ...endEvidence, sourceField: "reportDate" },
	]) {
		input.evidence = [...input.evidence.filter((item) => item.evidenceId !== "project-end"), invalid];
		expect(periodClaims().every((claim) => claim.value === 0)).toBe(true);
	}
	input.evidence = input.evidence.filter((item) => item.evidenceId !== "project-end");
	expect(periodClaims().every((claim) => claim.value === 0)).toBe(true);
});

it("verifies AML counts from referenced database records and rejects changed values", () => {
	const input = dataset();
	const baseEvidence = input.evidence[0];
	if (!baseEvidence) throw new Error("Missing test evidence");
	const counts = {
		suspiciousTransactionCount: 3,
		generalSuspiciousTransactionCount: 2,
		keySuspiciousTransactionCount: 1,
	};
	const evidence = Object.entries(counts).map(([field, value]) => ({
		...baseEvidence,
		evidenceId: `aml-${field}`,
		sourceId: "DS-07",
		sourceRecordId: "summary-database-uuid",
		sourceField: field,
		rawValue: String(value),
		normalizedValue: String(value),
	}));
	input.evidence = [...input.evidence, ...evidence];
	input.aml = {
		...counts,
		domains: [],
		suspiciousTransactionType: "一般可疑交易、重点可疑交易",
		allSuspiciousTransactionsReported: false,
		humanApprovedNoProblemBranch: false,
		problemQueryComplete: false,
		majorMatterQueryComplete: false,
		newAccountRiskRecords: [],
		periodicReviewRecords: [],
		regulatoryLetters: [],
		majorMatters: [],
		evidenceIds: evidence.map((item) => item.evidenceId),
	};
	const draft = generateReportDraft(input);
	draft.introduction.text = "共3笔，其中2笔为一般可疑交易，1笔为重点可疑交易。";
	draft.introduction.evidenceIds = input.aml.evidenceIds;
	const selected = () =>
		scoreStrictReportClaims(input, draft)
			.sentences.flatMap((sentence) => sentence.claims)
			.filter((claim) => /aml\.suspiciousTransaction(?:Count|GeneralCount|KeyCount)@/u.test(claim.claimId));
	expect(selected().length).toBeGreaterThanOrEqual(3);
	expect(selected().every((claim) => claim.value === 1)).toBe(true);
	input.evidence = input.evidence.map((item) =>
		item.evidenceId === "aml-generalSuspiciousTransactionCount"
			? { ...item, rawValue: "99", normalizedValue: "99" }
			: item,
	);
	expect(
		selected().some(
			(claim) => claim.claimId.startsWith("aml.suspiciousTransactionGeneralCount@") && claim.value === 0,
		),
	).toBe(true);
});

it("accepts the assigned template procedure but rejects the same text from another template", () => {
	const input = dataset();
	input.evidence = input.evidence.map((item) =>
		item.evidenceId === "procedure"
			? { ...item, rawValue: input.fixedFacts.auditProcedures, normalizedValue: input.fixedFacts.auditProcedures }
			: item,
	);
	const draft = generateReportDraft(input);
	const selected = () =>
		scoreStrictReportClaims(input, draft)
			.sentences.flatMap((sentence) => sentence.claims)
			.filter((claim) => claim.claimId.startsWith("narrative.auditProcedures@"));
	expect(selected().length).toBeGreaterThan(0);
	expect(selected().every((claim) => claim.value === 1)).toBe(true);
	input.evidence = input.evidence.map((item) =>
		item.evidenceId === "procedure" ? { ...item, sourceRecordId: "other-template" } : item,
	);
	expect(selected().every((claim) => claim.value === 0)).toBe(true);
});
