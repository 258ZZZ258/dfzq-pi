import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createAuditReportRequestContext,
	withAuditReportRequestContext,
} from "../../src/audit-report/report-context.ts";
import type { AuditReportDataset, AuditReportType } from "../../src/audit-report/report-contracts.ts";
import { loadAuditReportDataset } from "../../src/audit-report/report-data-source.ts";
import { type MockAuditSystem, startMockAuditSystem } from "../../src/audit-report/report-mock-system.ts";
import {
	assessSourceCoverage,
	buildFactPack,
	comparePreviousAuditFindings,
	findAdjacentRepeatedPhrase,
	generateReportDraft,
	renderReportMarkdown,
} from "../../src/audit-report/report-pipeline.ts";
import {
	getExecutableRubricItemCount,
	type ReportRunEvidence,
	scoreReport,
} from "../../src/audit-report/report-rubric.ts";
import { scoreStrictReportClaims } from "../../src/audit-report/report-strict-rubric.ts";
import { createAuditReportTools } from "../../src/audit-report/report-tools.ts";

const allowedTools = [
	"get_report_task",
	"get_organization_snapshot",
	"get_personnel_snapshot",
	"list_appointment_records",
	"get_operating_metrics",
	"list_audit_findings",
	"get_audit_finding_detail",
	"list_rectification_records",
	"list_risk_events",
	"get_aml_facts",
	"prepare_report_fact_pack",
	"generate_report_draft",
	"submit_report_draft",
];
const reportSkillRoot = fileURLToPath(new URL("../../skills/audit-report", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../fixtures/audit-report/source-simulation", import.meta.url));
const jobs: ReadonlyArray<{ taskId: string; reportType: AuditReportType }> = [
	{ taskId: "TASK-QF-REG-001", reportType: "regular" },
	{ taskId: "TASK-QF-TUR-001", reportType: "turnover" },
	{ taskId: "TASK-QF-AML-001", reportType: "aml" },
];

let system: MockAuditSystem | undefined;
let datasets: AuditReportDataset[];

function findReportTool(name: string) {
	const tool = createAuditReportTools(reportSkillRoot).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Tool not found: ${name}`);
	return tool;
}

function evidence(taskId: string): ReportRunEvidence {
	return {
		processedTaskIds: [taskId],
		toolsUsed: allowedTools,
		allowedTools,
		usedOpenNetwork: false,
		usedFreeSql: false,
		usedArbitraryFileWrite: false,
		schemaValidated: true,
		runMetadataComplete: true,
		writeIdsScoped: true,
		sensitiveDataMinimized: true,
		archivedByAuthorizedUser: false,
	};
}

beforeAll(async () => {
	const sourceWorkbook = resolve(sourceRoot, "模拟审计系统全量数据.xlsx");
	system = await startMockAuditSystem(sourceWorkbook);
	datasets = [];
	for (const job of jobs) {
		const loaded = await loadAuditReportDataset({
			...job,
			apiBaseUrl: system.baseUrl,
			operatingWorkbookPath: sourceWorkbook,
		});
		datasets.push(loaded.dataset);
	}
});

afterAll(async () => {
	await system?.close();
});

describe("audit report agent source integration", () => {
	it("implements the complete 108-item executable checklist", () => {
		expect(getExecutableRubricItemCount()).toBe(108);
	});

	it("loads business facts through HTTP APIs and Excel instead of code fixtures", () => {
		expect(system?.requestTrace.length).toBeGreaterThan(20);
		expect(datasets[0]?.operatingMetrics.length).toBe(12);
		expect(datasets[0]?.findings.length).toBe(9);
		expect(datasets[2]?.findings.every((finding) => finding.category === "反洗钱工作")).toBe(true);
		expect(system?.requestTrace.some((request) => request.path.startsWith("/api/audit/projects/previous?"))).toBe(
			true,
		);
	});

	it("queries performance only for people involved in the current report", () => {
		for (const dataset of datasets) {
			const involvedPersonIds = new Set([
				...dataset.appointments.map((record) => record.personId),
				...(dataset.task.subjectPersonId ? [dataset.task.subjectPersonId] : []),
			]);
			expect(dataset.performance.every((record) => involvedPersonIds.has(record.personId))).toBe(true);
		}
		expect(system?.requestTrace.some((request) => request.path.includes("/api/performance?personId="))).toBe(true);
		expect(system?.requestTrace.some((request) => request.path.endsWith("/api/performance"))).toBe(false);
	});

	it("does not read post-generation human review records as report inputs", () => {
		expect(system?.requestTrace.some((request) => request.path.startsWith("/api/manual-decisions"))).toBe(false);
		expect(datasets.every((dataset) => dataset.manualDecisions.length === 0)).toBe(true);
	});

	it.each([0, 1, 2])("generates an evidence-bound source dataset %s", (datasetIndex) => {
		const dataset = datasets[datasetIndex];
		if (!dataset) throw new Error(`Dataset ${datasetIndex} was not loaded`);
		const pack = buildFactPack(dataset);
		const draft = generateReportDraft(dataset, pack);
		const markdown = renderReportMarkdown(draft);
		expect(pack.blockers).toEqual([]);
		expect(draft.status).toBe("ready-for-review");
		for (const finding of dataset.findings) {
			if (!finding.isHistorical) expect(pack.disclosedFindingIds).toContain(finding.findingId);
			expect(markdown).toContain(finding.title);
		}
		const score = scoreReport(dataset, pack, draft, evidence(dataset.task.taskId));
		expect(score.criticalFailures).toContain("SAFE-010");
		expect(score.passRate).toBeGreaterThanOrEqual(95);
		expect(score.accepted).toBe(false);
	});

	it("blocks a fault-injected missing risk domain instead of writing a false no-event conclusion", () => {
		const base = datasets[0];
		if (!base) throw new Error("Regular dataset was not loaded");
		const dataset = structuredClone(base);
		dataset.riskEvents = [
			{
				eventId: "RISK-MISSING",
				type: "complaint",
				state: "MISSING",
				evidenceIds: [],
			},
		];
		const pack = buildFactPack(dataset);
		const draft = generateReportDraft(dataset, pack);
		const markdown = renderReportMarkdown(draft);
		expect(pack.blockers.length).toBeGreaterThan(0);
		expect(draft.status).toBe("needs-input");
		expect(markdown).toContain("BLOCKED");
		expect(markdown).not.toContain("未发生投诉、诉讼、处罚和损失事项");
	});

	it("separates source design completeness from production readiness", () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		const assessment = assessSourceCoverage(dataset);
		expect(assessment.designCoverage).toBeGreaterThan(90);
		expect(assessment.productionReadiness).toBeLessThan(70);
		expect(assessment.missingCapabilities).toContain("finding-count-semantics");
	});

	it("verifies every variable sentence against field-level source records", () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		const score = scoreReport(
			dataset,
			buildFactPack(dataset),
			generateReportDraft(dataset),
			evidence(dataset.task.taskId),
		);
		expect(score.strictClaims.accepted).toBe(true);
		expect(score.strictClaims.sentencePassRate).toBe(100);
		expect(score.strictClaims.claimVerificationRate).toBe(100);
		const employeeClaim = score.strictClaims.sentences
			.flatMap((sentence) => sentence.claims)
			.find((claim) => claim.claimText === "正式员工人数");
		expect(
			employeeClaim?.evidence.some((item) => item.sourceId === "DS-06" && item.sourceField === "employeeCount"),
		).toBe(true);
	});

	it("preserves the sourced manager-duty narrative without a hard-coded person or duplicated prefix", () => {
		const base = datasets[0];
		if (!base) throw new Error("Regular dataset was not loaded");
		const dataset = structuredClone(base);
		dataset.fixedFacts.managerDutySummary = "审计期内，王五同志履行营业部经营管理责任。";
		const draft = generateReportDraft(dataset);
		const managerDuty = draft.sections
			.flatMap((section) => section.subsections)
			.flatMap((subsection) => subsection.paragraphs)
			.find((item) => item.paragraphId === "regular-manager-duty");
		expect(managerDuty?.text).toBe(dataset.fixedFacts.managerDutySummary);
		expect(managerDuty?.text).not.toContain("卢俊同志");
		expect(managerDuty?.text).not.toContain("审计期内，审计期内");
	});

	it("does not prepend the turnover subject period twice when the sourced narrative already contains it", () => {
		const base = datasets[1];
		if (!base) throw new Error("Turnover dataset was not loaded");
		const dataset = structuredClone(base);
		const subjectName = dataset.task.subjectPersonName ?? "被审计人员";
		dataset.fixedFacts.internalControlSummary = `${subjectName}同志任职期内，其所在营业部岗位设置符合内部控制基本要求。`;
		const draft = generateReportDraft(dataset);
		const paragraphs = draft.sections.flatMap((section) => [
			...section.paragraphs,
			...section.subsections.flatMap((subsection) => subsection.paragraphs),
		]);
		const internalControl = paragraphs.find((item) => item.paragraphId === "turnover-internal-control");
		expect(internalControl?.text.match(new RegExp(`${subjectName}同志任职期内`, "gu"))?.length).toBe(1);
		expect(paragraphs.every((item) => findAdjacentRepeatedPhrase(item.text) === undefined)).toBe(true);
		const score = scoreReport(dataset, buildFactPack(dataset), draft, evidence(dataset.task.taskId));
		expect(score.items.find((item) => item.id === "RULE-017")?.value).toBe(1);
	});

	it("derives unresolved previous-audit findings by comparing prior and current records", () => {
		const base = datasets[1];
		if (!base) throw new Error("Turnover dataset was not loaded");
		const current = base.findings[0];
		if (!current) throw new Error("Turnover finding was not loaded");
		const previous = {
			...structuredClone(current),
			findingId: "PREVIOUS-F-001",
			projectId: "PRJ-QF-PREVIOUS",
			title: `个别${current.title.replace(/^(?:个别|部分)/u, "")}`,
			foundDate: "2022-12-31",
			isHistorical: true,
			isRepeat: false,
		};
		const dataset = {
			...structuredClone(base),
			findings: [previous, ...structuredClone(base.findings.filter((finding) => !finding.isHistorical))],
		};
		const comparison = comparePreviousAuditFindings(dataset.findings);
		expect(comparison.previousFindings.map((finding) => finding.findingId)).toEqual(["PREVIOUS-F-001"]);
		expect(comparison.unrectified).toHaveLength(1);
		expect(comparison.unrectified[0]?.current.findingId).toBe(current.findingId);
		expect(comparison.newFindings).toHaveLength(base.findings.filter((finding) => !finding.isHistorical).length - 1);
		const pack = buildFactPack(dataset);
		const draft = generateReportDraft(dataset, pack);
		const historicalParagraph = draft.sections
			.flatMap((section) => section.paragraphs)
			.find((paragraph) => paragraph.paragraphId === "turnover-historical-findings");
		expect(historicalParagraph?.text).toContain("审计中心上一次对其所在营业部开展审计发现的问题主要包括");
		expect(historicalParagraph?.text).toContain("未有效整改");
		const score = scoreReport(dataset, pack, draft, evidence(dataset.task.taskId));
		expect(score.items.find((item) => item.id === "TUR-007")?.value).toBe(1);
		expect(score.items.find((item) => item.id === "TUR-009")?.value).toBe(1);
	});

	it("requires the model to resolve an ambiguous same-class problem without pre-generation human blocking", async () => {
		const base = datasets[1];
		if (!base) throw new Error("Turnover dataset was not loaded");
		const current = base.findings[0];
		if (!current) throw new Error("Turnover finding was not loaded");
		const previous = {
			...structuredClone(current),
			findingId: "PREVIOUS-REVIEW-F-001",
			projectId: "PRJ-QF-PREVIOUS",
			subcategory: `${current.subcategory}持续管理`,
			title: `${current.title}仍需完善`,
			foundDate: "2022-12-31",
			isHistorical: true,
			isRepeat: false,
		};
		const dataset = {
			...structuredClone(base),
			findings: [previous, ...structuredClone(base.findings.filter((finding) => !finding.isHistorical))],
		};
		const comparison = comparePreviousAuditFindings(dataset.findings);
		expect(comparison.unrectified).toHaveLength(0);
		expect(comparison.needsReview).toHaveLength(1);
		const pack = buildFactPack(dataset);
		expect(pack.blockers.some((blocker) => blocker.includes("人工"))).toBe(false);
		const draft = generateReportDraft(dataset, pack);
		const historicalParagraph = draft.sections
			.flatMap((section) => section.paragraphs)
			.find((paragraph) => paragraph.paragraphId === "turnover-historical-findings");
		expect(historicalParagraph?.text).toContain("已转交大模型进行语义一致性判断");
		const context = createAuditReportRequestContext(dataset);
		await withAuditReportRequestContext(context, async () => {
			context.draft = draft;
			const submit = findReportTool("submit_report_draft");
			const baselineSubmission = await submit.execute(
				"submit-ambiguous-baseline",
				{ mode: "baseline" },
				undefined,
				undefined,
				{} as never,
			);
			expect(baselineSubmission.content[0]?.type === "text" ? baselineSubmission.content[0].text : "").toContain(
				"contains unresolved previous/current finding matches",
			);
			const resolvedSubmission = await submit.execute(
				"submit-resolved-history",
				{
					mode: "paragraph-patch",
					paragraphChangesJson: JSON.stringify([
						{
							paragraphId: "turnover-historical-findings",
							text: `${dataset.task.subjectPersonName}同志任职期内，审计中心上一次对其所在营业部开展审计发现的问题主要包括：${previous.title}等问题。经与本次审计发现的问题逐项比对，上述问题本次未再发现，认定为已整改。`,
						},
					]),
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(resolvedSubmission.content[0]?.type === "text" ? resolvedSubmission.content[0].text : "").toContain(
				"Draft accepted",
			);
		});
	});

	it("derives turnover title, appointment actions, and the reporting window from OA appointment records", () => {
		const base = datasets[1];
		if (!base) throw new Error("Turnover dataset was not loaded");
		const draft = generateReportDraft(base);
		const text = renderReportMarkdown(draft);
		const subjectAppointments = base.appointments.filter((record) => record.personId === base.task.subjectPersonId);
		expect(subjectAppointments.length).toBeGreaterThanOrEqual(2);
		for (const record of subjectAppointments) {
			const title = record.fullTitle ?? record.title;
			expect(text).toContain(
				record.action === "remove"
					? `免去${record.personName}同志的${title}`
					: `聘任${record.personName}同志为${title}`,
			);
		}
		expect(draft.titleLines[0]).not.toContain("营业部负责人负责人");
		const score = scoreReport(base, buildFactPack(base), draft, evidence(base.task.taskId));
		expect(score.items.find((item) => item.id === "TUR-013")?.value).toBe(1);
	});

	it("accepts punctuation-only clause boundaries when each clause is directly traceable to cited source text", () => {
		const base = datasets[0];
		if (!base) throw new Error("Regular dataset was not loaded");
		const dataset = structuredClone(base);
		const sourceText = "举报事项标题2024年6月公司收到监管转办材料";
		dataset.fixedFacts.managerDutySummary = sourceText;
		const evidenceRecord = dataset.evidence.find(
			(record) => record.sourceId === "DS-10" && record.sourceField === "managerDutySummary",
		);
		if (!evidenceRecord) throw new Error("Manager-duty narrative evidence was not loaded");
		evidenceRecord.rawValue = sourceText;
		evidenceRecord.normalizedValue = sourceText;
		const draft = generateReportDraft(dataset);
		const managerDuty = draft.sections
			.flatMap((section) => section.subsections)
			.flatMap((subsection) => subsection.paragraphs)
			.find((item) => item.paragraphId === "regular-manager-duty");
		if (!managerDuty) throw new Error("Manager-duty paragraph was not generated");
		managerDuty.text = "举报事项标题：2024年6月，公司收到监管转办材料。";
		const score = scoreStrictReportClaims(dataset, draft);
		expect(score.accepted).toBe(true);
		expect(score.unsupportedClaimCount).toBe(0);
	});

	it("fails a factual sentence that reuses evidence while inventing an unsupported value", () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		const baseline = generateReportDraft(dataset);
		const tampered = {
			...baseline,
			sections: baseline.sections.map((section, index) =>
				index === 0
					? {
							...section,
							paragraphs: [
								...section.paragraphs,
								{
									paragraphId: "tampered-employee-count",
									text: "截至审计期末，营业部共有正式员工999名。",
									evidenceIds: dataset.personnel.evidenceIds,
									requiresHumanReview: false,
								},
							],
						}
					: section,
			),
		};
		const score = scoreReport(dataset, buildFactPack(dataset), tampered, evidence(dataset.task.taskId));
		expect(score.strictClaims.accepted).toBe(false);
		expect(score.strictClaims.unsupportedClaimCount).toBeGreaterThan(0);
		expect(score.criticalFailures.some((id) => id.startsWith("CLAIM-SENT-"))).toBe(true);
	});

	it("blocks organization access outside the current report task", async () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		await withAuditReportRequestContext(createAuditReportRequestContext(dataset), async () => {
			const result = await findReportTool("get_organization_snapshot").execute(
				"org-denied",
				{ organizationId: "ORG-OTHER" },
				undefined,
				undefined,
				{} as never,
			);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Access denied");
		});
	});

	it("rejects model changes to template-locked paragraphs", async () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		const context = createAuditReportRequestContext(dataset);
		await withAuditReportRequestContext(context, async () => {
			context.draft = generateReportDraft(dataset);
			const submit = findReportTool("submit_report_draft");
			const submission = await submit.execute(
				"submit-locked-patch",
				{
					mode: "paragraph-patch",
					paragraphChangesJson: JSON.stringify([
						{ paragraphId: "regular-introduction", text: "模型自行改写固定引言。" },
					]),
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(submission.content[0]?.type === "text" ? submission.content[0].text : "").toContain(
				"template-locked paragraphs cannot be changed",
			);
			expect(context.draftSchemaValidated).not.toBe(true);
		});
	});

	it("normalizes Chinese punctuation in the only model-editable operating analysis paragraph", async () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		const context = createAuditReportRequestContext(dataset);
		await withAuditReportRequestContext(context, async () => {
			context.draft = generateReportDraft(dataset);
			const submit = findReportTool("submit_report_draft");
			const submission = await submit.execute(
				"submit-operating-patch",
				{
					mode: "paragraph-patch",
					paragraphChangesJson: JSON.stringify([
						{
							paragraphId: "regular-operating-analysis",
							text: "经审计,经审计,营业部收入增长:排名保持稳定;未见异常!",
						},
					]),
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(submission.content[0]?.type === "text" ? submission.content[0].text : "").toContain("Draft accepted");
			const operatingAnalysis = context.draft?.sections
				.flatMap((section) => section.subsections)
				.flatMap((subsection) => subsection.paragraphs)
				.find((paragraph) => paragraph.paragraphId === "regular-operating-analysis");
			expect(operatingAnalysis?.text).toBe("经审计，营业部收入增长：排名保持稳定；未见异常！");
			expect(context.draftSchemaValidated).toBe(true);
		});
	});

	it("blocks placeholder organization values instead of writing simulated addresses or zero counts", () => {
		const base = datasets[0];
		if (!base) throw new Error("Regular dataset was not loaded");
		const dataset = structuredClone(base);
		dataset.organization.address = "机构主数据接口模拟地址";
		dataset.organization.areaSquareMeters = 0;
		dataset.personnel.employeeCount = 0;
		const pack = buildFactPack(dataset);
		const draft = generateReportDraft(dataset, pack);
		const markdown = renderReportMarkdown(draft);
		expect(pack.blockers.some((blocker) => blocker.startsWith("common.organization:"))).toBe(true);
		expect(draft.status).toBe("needs-input");
		expect(markdown).not.toContain("机构主数据接口模拟地址");
		expect(markdown).not.toContain("营业面积0平方米");
		expect(markdown).not.toContain("正式员工0名");
	});

	it("does not require unused organization-overview fields for AML reports", () => {
		const base = datasets[2];
		if (!base) throw new Error("AML dataset was not loaded");
		const dataset = structuredClone(base);
		dataset.organization.address = "机构主数据接口模拟地址";
		dataset.organization.areaSquareMeters = 0;
		dataset.personnel.employeeCount = 0;
		const pack = buildFactPack(dataset);
		expect(pack.blockers.some((blocker) => blocker.startsWith("common.organization:"))).toBe(false);
		expect(generateReportDraft(dataset, pack).status).toBe("ready-for-review");
	});

	it("accepts the complete generated baseline without re-emitting the full draft JSON", async () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		const context = createAuditReportRequestContext(dataset);
		await withAuditReportRequestContext(context, async () => {
			context.draft = generateReportDraft(dataset);
			const submit = findReportTool("submit_report_draft");
			const submission = await submit.execute(
				"submit-baseline",
				{ mode: "baseline" },
				undefined,
				undefined,
				{} as never,
			);
			expect(submission.content[0]?.type === "text" ? submission.content[0].text : "").toContain("Draft accepted");
			expect(context.draftSchemaValidated).toBe(true);
		});
	});

	it("restricts report read access to the audit-report Skill", async () => {
		const dataset = datasets[0];
		if (!dataset) throw new Error("Regular dataset was not loaded");
		await withAuditReportRequestContext(createAuditReportRequestContext(dataset), async () => {
			const read = findReportTool("read");
			const allowed = await read.execute("read-allowed", { path: "SKILL.md" }, undefined, undefined, {} as never);
			const denied = await read.execute(
				"read-denied",
				{ path: "../../package.json" },
				undefined,
				undefined,
				{} as never,
			);
			expect(allowed.content[0]?.type === "text" ? allowed.content[0].text : "").toContain("审计报告生成");
			expect(denied.content[0]?.type === "text" ? denied.content[0].text : "").toContain("Access denied");
		});
	});
});
