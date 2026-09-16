import { expect, it } from "vitest";
import { buildCleanPracticeSummary } from "../src/audit-report/report-clean-practice.ts";
import type {
	AuditFinding,
	AuditReportDataset,
	AuditReportType,
	BusinessCheck,
	EvidenceRecord,
} from "../src/audit-report/report-contracts.ts";
import { buildControlSummary } from "../src/audit-report/report-control-summary.ts";
import { generateReportDraft } from "../src/audit-report/report-pipeline.ts";
import { planReportSemantics } from "../src/audit-report/report-semantic.ts";
import { scoreStrictReportClaims } from "../src/audit-report/report-strict-rubric.ts";
import { REGULAR_CHECKS } from "../src/audit-report/report-workflow.ts";

function input(type: AuditReportType = "regular"): AuditReportDataset {
	const checks: BusinessCheck[] = [];
	const evidence: EvidenceRecord[] = [];
	for (const [index, code] of REGULAR_CHECKS.entries()) {
		const result = index === 0 ? "exception" : index === 1 ? "not-applicable" : "conforming";
		const factText =
			index === 0 ? "抽查3笔记录，发现1笔未履行审批。" : index === 1 ? "本期未开展相关业务。" : undefined;
		const refs: string[] = [];
		for (const [field, value] of [
			["result", result],
			["factText", factText],
		] as const) {
			if (value === undefined) continue;
			const id = `check-${index}-${field}`;
			refs.push(id);
			evidence.push({
				evidenceId: id,
				sourceId: "DS-03",
				sourceRecordId: `db-${index}`,
				sourceField: field,
				rawValue: value,
				normalizedValue: value,
				dataVersion: "revision-1",
				asOf: "2026-03-31",
				queryTime: "2026-09-11T00:00:00Z",
			});
		}
		checks.push({ code, result, factText, evidenceIds: refs });
	}
	return {
		caseId: "control-test",
		description: "Minimal control integration input; other report domains intentionally incomplete",
		task: {
			taskId: "task",
			projectId: "project",
			organizationId: "branch",
			reportType: type,
			auditStart: "2025-01-01",
			auditEnd: "2026-03-31",
			auditGroupEstablishedMonth: "2026年4月",
			reportDate: "2026-05-01",
			templateId: "template",
			templateVersion: "1",
			closingOrganization: "审计中心",
			feedbackCompleted: false,
			workflow: {
				mode: type === "regular" ? "independent" : type,
				matchingCompleted: true,
				consultationExists: false,
			},
		},
		organization: {
			organizationId: "branch",
			organizationCode: "001",
			fullName: "测试营业部",
			address: "测试路1号",
			areaSquareMeters: 100,
			asOf: "2026-03-31",
			evidenceIds: [],
		},
		personnel: { organizationId: "branch", employeeCount: 1, brokerCount: 0, asOf: "2026-03-31", evidenceIds: [] },
		checks,
		evidence,
		sources: [],
		appointments: [],
		operatingMetrics: [],
		findings: [],
		riskEvents: [],
		performance: [],
		manualDecisions: [],
		fixedFacts: {
			auditProcedures: "",
			internalControlSummary: "故意提供错误结论：全部正常，未发生任何事故。",
			managerDutySummary: "",
			previousRectificationSummary: "",
			historicalFindingSummary: "",
			cleanPracticeSummary: "",
		},
	};
}

it("clean-practice output uses checked facts and never the supplied exoneration; rubric rejects changes", () => {
	const dataset = input("turnover");
	const id = "petition-result";
	dataset.checks = [
		...(dataset.checks ?? []),
		{
			code: "信访及案件",
			result: "exception",
			factText: "收到一件信访，正在核查。",
			evidenceIds: [id, "petition-fact"],
		},
	];
	dataset.evidence = [
		...dataset.evidence,
		...(["result", "factText"] as const).map((field) => ({
			...dataset.evidence[0]!,
			evidenceId: field === "result" ? id : "petition-fact",
			sourceRecordId: "petition-record",
			sourceField: field,
			rawValue: field === "result" ? "exception" : "收到一件信访，正在核查。",
			normalizedValue: field === "result" ? "exception" : "收到一件信访，正在核查。",
		})),
	];
	dataset.fixedFacts.cleanPracticeSummary = "未受理任何案件，未发现重大违法违规事项。";
	const summary = buildCleanPracticeSummary(dataset);
	expect(summary.errors).toEqual([]);
	expect(summary.text).toBe("廉洁从业管理检查结果：符合要求。信访及案件检查结果：存在异常，收到一件信访，正在核查。");
	const draft = generateReportDraft(dataset);
	const paragraph = draft.sections
		.flatMap((s) => s.subsections.flatMap((sub) => sub.paragraphs))
		.find((p) => p.paragraphId === "turnover-clean-practice")!;
	expect(paragraph.text).toBe(summary.text);
	expect(paragraph.evidenceIds).toEqual(summary.evidenceIds);
	const scores = () =>
		scoreStrictReportClaims(dataset, draft).sentences.filter((s) => s.location.includes("turnover-clean-practice"));
	expect(scores()).toHaveLength(2);
	expect(scores().every((s) => s.value === 1)).toBe(true);
	paragraph.text = dataset.fixedFacts.cleanPracticeSummary;
	expect(scores().some((s) => s.value === 0)).toBe(true);
	paragraph.text = summary.text;
	paragraph.evidenceIds = [];
	expect(scores().every((s) => s.value === 0)).toBe(true);
	dataset.evidence = dataset.evidence.map((e) =>
		e.evidenceId === "petition-fact" ? { ...e, dataVersion: "wrong" } : e,
	);
	expect(buildCleanPracticeSummary(dataset).text).toBe("");
	expect(generateReportDraft(dataset).blockers.some((b) => b.startsWith("clean-practice:"))).toBe(true);
});

it.each(["regular", "consultation", "turnover"] as const)(
	"builds the actual %s historical paragraph without accepting supplied conclusions or bypassing missing data",
	(type) => {
		const dataset = input(type);
		const historical: AuditFinding = {
			findingId: "H",
			projectId: "previous",
			organizationId: "branch",
			category: "综合管理",
			subcategory: "信息公示",
			findingType: "制度执行类",
			severity: "一般",
			title: "人员信息公示不完整",
			policyBasis: "应完整公示人员信息。",
			factText: "经纪人员姓名没有公示。",
			issueCount: 1,
			foundDate: "2024-12-01",
			status: "closed",
			isHistorical: true,
			isRepeat: false,
			isSubjectResponsible: false,
			evidenceIds: ["history-fact"],
		};
		dataset.findings = [
			historical,
			{
				...historical,
				findingId: "C",
				projectId: "project",
				isHistorical: false,
				factText: "本次仍未公示经纪人员姓名。",
				evidenceIds: ["current-fact"],
			},
		];
		dataset.fixedFacts.previousRectificationSummary = "上次问题已全部整改。";
		const draft = generateReportDraft(dataset);
		const paragraphs = draft.sections.flatMap((s) => [
			...s.paragraphs,
			...s.subsections.flatMap((sub) => sub.paragraphs),
		]);
		const id = type === "turnover" ? "turnover-historical-findings" : "regular-previous-rectification";
		const paragraph = paragraphs.find((p) => p.paragraphId === id);
		expect(paragraph?.text).toContain(historical.title);
		expect(paragraph?.text).not.toContain("全部整改");
		expect(paragraph?.evidenceIds).toContain("history-fact");
		const state = planReportSemantics(dataset, draft, { enabled: false, maxAttempts: 2, summaryFindingThreshold: 8 });
		expect(draft.status).toBe("needs-input");
		expect(state.jobs).toHaveLength(0); // Do not send deliberately incomplete report inputs to the model.
		dataset.findings = [historical];
		expect(generateReportDraft(dataset).blockers.some((b) => b.includes("本次列表为空"))).toBe(true);
		dataset.findings = [];
		expect(generateReportDraft(dataset).blockers.some((b) => b.includes("前次审计存在问题"))).toBe(false);
	},
);

it.each(["regular", "consultation", "turnover"] as const)(
	"renders %s from original checks and binds the actual database evidence",
	(type) => {
		const dataset = input(type);
		const summary = buildControlSummary(dataset);
		expect(summary.errors).toEqual([]);
		expect(summary.text).toBe(
			"内部控制检查共涉及12项，其中10项符合要求、1项存在异常、1项不适用。岗位设置：存在异常，抽查3笔记录，发现1笔未履行审批。不相容职务分离：不适用，本期未开展相关业务。",
		);
		const draft = generateReportDraft(dataset);
		const paragraph = draft.sections
			.flatMap((section) => section.subsections.flatMap((subsection) => subsection.paragraphs))
			.find((p) => p.paragraphId.endsWith("-internal-control"));
		expect(paragraph?.text).toBe(summary.text);
		expect(paragraph?.evidenceIds).toEqual(summary.evidenceIds);
		expect(paragraph?.text).not.toContain("未发生");
		const verified = scoreStrictReportClaims(dataset, draft).sentences.filter((sentence) =>
			/paragraph\[(?:regular|turnover)-internal-control\]/u.test(sentence.location),
		);
		expect(verified).toHaveLength(3);
		expect(verified.every((sentence) => sentence.value === 1)).toBe(true);
		expect(draft.status).toBe("needs-input"); // Other report inputs are deliberately absent.
	},
);

it.each(["13项", "-12项", "12项符合要求", "内控全面健全有效。"])(
	"strict scoring rejects changed content: %s",
	(changed) => {
		const dataset = input("turnover");
		const draft = generateReportDraft(dataset);
		const paragraph = draft.sections
			.flatMap((s) => s.subsections.flatMap((sub) => sub.paragraphs))
			.find((p) => p.paragraphId === "turnover-internal-control");
		if (!paragraph) throw new Error("Missing control paragraph");
		paragraph.text = changed.endsWith("。")
			? changed
			: paragraph.text.replace(changed.includes("符合") ? "10项符合要求" : "12项", changed);
		const scores = scoreStrictReportClaims(dataset, draft).sentences.filter((s) =>
			s.location.includes("turnover-internal-control"),
		);
		expect(scores.some((s) => s.value === 0)).toBe(true);
	},
);

it("does not certify a correct summary after a paragraph evidence reference was removed", () => {
	const dataset = input();
	const draft = generateReportDraft(dataset);
	const paragraph = draft.sections
		.flatMap((s) => s.subsections.flatMap((sub) => sub.paragraphs))
		.find((p) => p.paragraphId === "regular-internal-control");
	if (!paragraph) throw new Error("Missing control paragraph");
	paragraph.evidenceIds = paragraph.evidenceIds.filter((id) => id !== "check-11-result");
	expect(
		scoreStrictReportClaims(dataset, draft).sentences.some(
			(s) => s.location.includes("regular-internal-control") && s.value === 0,
		),
	).toBe(true);
});

it("missing checks or stale/missing fact evidence block generation without using the supplied conclusion", () => {
	for (const change of ["missing", "stale", "fact", "duplicate"] as const) {
		const dataset = input();
		if (change === "missing") dataset.checks = dataset.checks?.slice(1);
		if (change === "duplicate") dataset.checks = [...(dataset.checks ?? []), ...(dataset.checks?.slice(0, 1) ?? [])];
		if (change === "stale")
			dataset.evidence = dataset.evidence.map((e) =>
				e.evidenceId === "check-0-factText" ? { ...e, dataVersion: "other" } : e,
			);
		if (change === "fact") dataset.evidence = dataset.evidence.filter((e) => e.evidenceId !== "check-0-factText");
		expect(buildControlSummary(dataset).text).toBe("");
		expect(generateReportDraft(dataset).blockers.some((message) => message.startsWith("control-summary:"))).toBe(
			true,
		);
	}
});
