import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "@e965/xlsx";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildFactPack,
	generateReportDraft,
	getExecutableRubricItemCount,
	loadAuditReportDataset,
	scoreReport,
	toAuditReportJavaDocument,
} from "../src/audit-report/index.ts";
import { auditReportDelivery } from "../src/audit-report/report-delivery.ts";
import { parseReportInput } from "../src/audit-report/report-input.ts";
import { reportBasisNeedsRecheck, reportDocumentMatches } from "../src/audit-report/report-java-contract.ts";
import { scoreStrictReportClaims } from "../src/audit-report/report-strict-rubric.ts";
import { createBoundAuditReportTools } from "../src/audit-report/report-tools.ts";
import { businessCheckErrors, TURNOVER_CHECKS, workflowErrors } from "../src/audit-report/report-workflow.ts";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import { validateSubmitBody } from "../src/server/middleware/validate.ts";
import { resolveSpecPromptPaths } from "../src/spec/resolve-prompt-paths.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { type SourceRow, type SourceTables, startAuditReportMockSystem } from "./fixtures/audit-report-mock-system.ts";
import { createFauxHarness, fauxAssistantMessage, fauxToolCall } from "./helpers/faux.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(packageRoot, "test", "fixtures", "audit-report-source.json");
const specPath = join(packageRoot, "specs", "audit-report.json");
const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://unused.test",
	apiKeyEnv: "UNUSED_TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux-model",
			contextWindow: 128000,
			maxTokens: 8192,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

type Fixture = SourceTables & {
	经营数据: Array<Array<string | number | null>>;
	指标字典: SourceRow[];
	排名参与家数: SourceRow[];
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
});

async function loadSourceDataset(prepare?: (fixture: Fixture) => void) {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
	prepare?.(fixture);
	const root = await mkdtemp(join(tmpdir(), "audit-report-source-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(fixture.经营数据), "经营数据");
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixture.指标字典), "指标字典");
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixture.排名参与家数), "排名参与家数");
	const workbookPath = join(root, "operating.xlsx");
	await writeFile(workbookPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

	const tables = { ...fixture } as Record<string, SourceRow[]>;
	delete tables.经营数据;
	delete tables.指标字典;
	delete tables.排名参与家数;
	const mock = await startAuditReportMockSystem(tables);
	cleanups.push(mock.close);
	const loaded = await loadAuditReportDataset({
		taskId: "TASK-001",
		reportType: "regular",
		apiBaseUrl: mock.baseUrl,
		operatingWorkbookPath: workbookPath,
	});
	return { ...loaded, requests: mock.requests };
}

describe("audit-report RuntimeSpec", () => {
	it("reads exception explanations from the checks endpoint and exposes their actual paragraph basis", async () => {
		const { dataset } = await loadSourceDataset((fixture) => {
			const check = fixture.业务检查?.find((row) => row.code === "岗位设置");
			if (!check) throw new Error("Missing checklist test record");
			check.result = "exception";
			check.factText = "抽查发现审批记录不完整。";
		});
		const check = dataset.checks?.find((row) => row.code === "岗位设置");
		const proof = dataset.evidence.find(
			(item) => check?.evidenceIds.includes(item.evidenceId) && item.sourceField === "factText",
		);
		expect(proof?.rawValue).toBe("抽查发现审批记录不完整。");
		expect(proof?.sourceId).toBe("DS-03");
		expect(
			dataset.evidence.some((item) => item.sourceId === "DS-10" && item.sourceField === "internalControlSummary"),
		).toBe(false);
		const draft = generateReportDraft(dataset);
		const doc = toAuditReportJavaDocument(dataset, draft);
		const paragraph = doc.nodes.find((node) => node.nodeId === "regular-internal-control");
		expect(paragraph?.text).toBe(dataset.fixedFacts.internalControlSummary);
		expect(paragraph?.citationIds).toContain(proof?.evidenceId);
		expect(paragraph?.basis?.sourceGroups.some((group) => group.citationIds.includes(proof?.evidenceId ?? ""))).toBe(
			true,
		);
		const scores = scoreStrictReportClaims(dataset, draft).sentences.filter((sentence) =>
			sentence.location.includes("regular-internal-control"),
		);
		expect(scores.length).toBeGreaterThan(0);
		expect(scores.every((sentence) => sentence.value === 1)).toBe(true);
	});
	it("accepts embedded policy text and gates delivery until semantic work finishes", async () => {
		const { dataset } = await loadSourceDataset((fixture) => {
			const finding = fixture.审计发现![0]!;
			finding.factText = `${finding.policyBasis}审计发现以下问题：（1）人数缺失。未登记人数。（2）对象缺失。另有记录未登记对象。`;
			finding.policyBasis = "";
			finding.internalSubitems = "";
		});
		expect(dataset.findings[0]!.policyBasis).toBe("");
		const tools = createBoundAuditReportTools(dataset, join(packageRoot, "specs", "audit-report", "skills"));
		const call = async (name: string, params: Record<string, unknown> = {}) => {
			const tool = tools.find((item) => item.name === name)!;
			return tool.execute("test", params, undefined, undefined, {} as never);
		};
		const content = (response: Awaited<ReturnType<typeof call>>) =>
			JSON.parse(
				response.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join(""),
			);
		const initial = content(await call("generate_report_draft"));
		expect(initial.status).toBe("semantic-pending");
		const id = initial.jobs[0].id as string;
		await expect(call("resolve_report_document", { referenceJson: "{}" })).rejects.toThrow("reference");
		expect((await call("revise_report_draft", { paragraphChangesJson: "[]" })).details).toMatchObject({
			valid: false,
		});
		const job = content(await call("get_report_semantic_job", { jobId: id }));
		const groups = job.atoms.map((atom: { id: string }) => [atom.id]);
		expect(
			content(await call("submit_report_semantic_job", { jobId: id, proposalJson: JSON.stringify({ groups }) }))
				.status,
		).toBe("accepted");
		const reference = content(await call("generate_report_draft"));
		const document = content(await call("resolve_report_document", { referenceJson: JSON.stringify(reference) }));
		expect(
			document.nodes.find(
				(node: { nodeId: string }) => node.nodeId === `finding-${dataset.findings[0]!.findingId}-fact`,
			).text,
		).toContain("\n");
		expect(
			(await call("validate_report_document", { documentJson: JSON.stringify(document) })).details,
		).toMatchObject({ valid: true });
		expect(
			document.nodes.some(
				(node: { nodeType: string; text?: string }) => node.nodeType === "paragraph" && !node.text?.trim(),
			),
		).toBe(false);
		await call("begin_report_run");
		await expect(call("resolve_report_document", { referenceJson: JSON.stringify(reference) })).rejects.toThrow(
			"reference",
		);
		expect(content(await call("generate_report_draft")).status).toBe("semantic-pending");
		expect(content(await call("submit_report_semantic_job", { jobId: id, proposalJson: "invalid" })).status).toBe(
			"pending",
		);
		expect(content(await call("submit_report_semantic_job", { jobId: id, proposalJson: "invalid" })).status).toBe(
			"retained",
		);
		const fallbackRef = content(await call("generate_report_draft"));
		const fallback = content(await call("resolve_report_document", { referenceJson: JSON.stringify(fallbackRef) }));
		expect(fallback).toEqual(toAuditReportJavaDocument(dataset, generateReportDraft(dataset)));
	});
	it("mock endpoints scope performance by person and select the latest previous project", async () => {
		const mock = await startAuditReportMockSystem({
			绩效考核: [
				{ personId: "A", year: 2025, rating: "A" },
				{ personId: "B", year: 2025, rating: "B" },
			],
			审计项目: [
				{ taskId: "old", organizationId: "ORG", auditEnd: "2023-01-01" },
				{ taskId: "latest", organizationId: "ORG", auditEnd: "2024-01-01" },
				{ taskId: "other", organizationId: "OTHER", auditEnd: "2024-12-31" },
				{ taskId: "current", organizationId: "ORG", auditEnd: "2025-12-31" },
			],
		});
		cleanups.push(mock.close);
		const performance = await (await fetch(`${mock.baseUrl}/api/performance?personId=A`)).json();
		expect(performance).toMatchObject({ data: [{ personId: "A", year: 2025, rating: "A" }] });
		const previous = await (
			await fetch(`${mock.baseUrl}/api/audit/projects/previous?organizationId=ORG&before=2025-01-01`)
		).json();
		expect(previous).toMatchObject({ data: { taskId: "latest" } });
	});
	it("requires a generated baseline and isolates it from caller mutation", async () => {
		const { dataset } = await loadSourceDataset();
		const expected = toAuditReportJavaDocument(dataset, generateReportDraft(dataset));
		const tools = createBoundAuditReportTools(dataset, join(packageRoot, "specs", "audit-report", "skills"));
		const validator = tools.find((t) => t.name === "validate_report_document")!;
		const generator = tools.find((t) => t.name === "generate_report_draft")!;
		const check = async (doc: unknown) =>
			(await validator.execute("test", { documentJson: JSON.stringify(doc) }, undefined, undefined, {} as never))
				.details;
		expect(await check(expected)).toEqual({ valid: false });
		dataset.organization.fullName = "调用方修改的营业部";
		await generator.execute("test", {}, undefined, undefined, {} as never);
		expect(await check(expected)).toEqual({ valid: true });
		const changed = structuredClone(expected);
		changed.citations[0]!.summary = "伪造的来源值";
		expect(await check(changed)).toEqual({ valid: false });
	});
	it("generates independent regular report with AML attachment without feedback claims", async () => {
		const { dataset } = await loadSourceDataset();
		dataset.task.feedbackCompleted = false;
		const draft = generateReportDraft(dataset);
		expect(draft.blockers).toEqual([]);
		expect(draft.introduction.text).not.toContain("得到了确认和反馈");
		expect(draft.sections.filter((s) => s.heading === "附件：反洗钱审计情况")).toHaveLength(1);
		expect(JSON.stringify(draft)).not.toContain("均为一般可疑交易");
		expect(
			toAuditReportJavaDocument(dataset, draft)
				.nodes.filter((n) => n.nodeType === "paragraph" && n.basis?.kind === "missing")
				.map((n) => n.nodeId),
		).toEqual([]);
	});

	it("generates consultation before feedback, with deadline and no AML attachment", async () => {
		const { dataset } = await loadSourceDataset();
		dataset.task.reportType = "consultation";
		dataset.task.feedbackCompleted = false;
		dataset.task.workflow = {
			mode: "consultation",
			matchingCompleted: true,
			consultationExists: false,
			feedbackDeadline: "2026-02-15",
			feedbackRequirement: "应认真制定整改计划并反馈书面意见。",
		};
		const draft = generateReportDraft(dataset);
		expect(draft.blockers).toEqual([]);
		expect(draft.titleLines).toContain("审计征求意见书");
		expect(draft.sections.at(-1)?.paragraphs[0]?.text).toContain("2026年2月15日");
		expect(draft.sections.at(-1)?.paragraphs[0]?.text).toBe(
			"应认真制定整改计划并反馈书面意见。反馈截止日期为2026年2月15日。",
		);
		expect(draft.sections).toHaveLength(3);
		expect(JSON.stringify(draft)).not.toContain("attachment-aml");
	});

	it("linked generation requires a complete source version and resolved feedback", async () => {
		const { dataset } = await loadSourceDataset();
		dataset.task.workflow = {
			mode: "linked",
			matchingCompleted: true,
			consultationExists: true,
			sourceReportId: "C-1",
			sourceVersion: 2,
			sourceDataVersion: "C-1:4",
			feedbackStatus: "completed",
			resolutionStatus: "completed",
			feedbackCompletedAt: "2026-01-31",
		};
		expect(generateReportDraft(dataset).introduction.text).toContain("得到了确认和反馈");
		dataset.task.workflow.resolutionStatus = "pending";
		const draft = generateReportDraft(dataset);
		expect(draft.status).toBe("needs-input");
		expect(draft.introduction.text).not.toContain("得到了确认和反馈");
	});

	it("cannot bypass matching, missing checks, or completed feedback by supplying a fact pack", async () => {
		const { dataset } = await loadSourceDataset();
		const pack = buildFactPack(dataset);
		dataset.task.workflow = { mode: "independent", matchingCompleted: false, consultationExists: true };
		dataset.checks = [];
		expect(generateReportDraft(dataset, pack).status).toBe("needs-input");
		expect(workflowErrors(dataset.task).length).toBeGreaterThan(0);
		expect(businessCheckErrors(dataset)).toHaveLength(20);
	});

	it("namespaces identical finding references in regular body and attachment", async () => {
		const { dataset } = await loadSourceDataset();
		dataset.findings = dataset.findings.map((f) => ({ ...f, category: "反洗钱工作" }));
		const document = toAuditReportJavaDocument(dataset, generateReportDraft(dataset));
		expect(document.nodes.some((n) => n.nodeId === "finding-F-001-fact")).toBe(true);
		expect(document.nodes.some((n) => n.nodeId === "attachment-finding-F-001-fact")).toBe(true);
		expect(new Set(document.nodes.map((n) => n.nodeId)).size).toBe(document.nodes.length);
	});

	it("validates actual Java snapshot identity and prevents cross-organization input", async () => {
		const { dataset } = await loadSourceDataset();
		const payload = { schemaVersion: "audit-report-input.v2", dataset };
		expect(parseReportInput(payload, "TASK-001", "regular").task.taskId).toBe("TASK-001");
		expect(() => parseReportInput(payload, "OTHER", "regular")).toThrow("mismatch");
		dataset.organization.organizationId = "OTHER";
		expect(() => parseReportInput(payload, "TASK-001", "regular")).toThrow("Cross-organization");
	});
	it("accepts Java request envelope and rejects invalid workflow primitive types", async () => {
		const { dataset } = await loadSourceDataset();
		const payload = { schemaVersion: "audit-report-input.v2", dataset };
		expect(
			validateSubmitBody({
				taskKind: "audit-report",
				input: "生成报告",
				clientRequestId: "TASK-001:1",
				sessionId: "TASK-001",
				waitMs: 0,
				filters: { owner: "user", projectId: dataset.task.projectId, corpusTypes: ["internal"] },
				options: { reportTaskId: "TASK-001", reportType: "regular" },
				payload,
			}).ok,
		).toBe(true);
		const broken = JSON.parse(JSON.stringify(payload));
		broken.dataset.task.workflow.matchingCompleted = "true";
		expect(() => parseReportInput(broken, "TASK-001", "regular")).toThrow("must be boolean");
	});
	it("does not produce empty category phrases when all findings have been deleted", async () => {
		const { dataset } = await loadSourceDataset();
		dataset.findings = [];
		const draft = generateReportDraft(dataset);
		expect(JSON.stringify(draft)).not.toContain("营业部在等");
		expect(draft.sections[1]?.paragraphs[0]?.text).toContain("未发现需列示的问题");
		expect(draft.reportDate).toBe("2026年2月1日");
	});

	it("requires 18 turnover business checks and does not attach a separate AML report", async () => {
		const { dataset } = await loadSourceDataset((fixture) => {
			fixture.业务检查?.push({ taskId: "TASK-001", code: "信访及案件", result: "conforming" });
			fixture.绩效考核 = [{ personId: "PERSON-001", year: 2025, rating: "A" }];
		});
		const originalChecks = dataset.checks ?? [];
		dataset.task.reportType = "turnover";
		dataset.task.subjectPersonId = "PERSON-001";
		dataset.task.subjectPersonName = "张三";
		dataset.task.workflow = { mode: "turnover", matchingCompleted: true, consultationExists: false };
		dataset.checks = TURNOVER_CHECKS.map((code) => ({ code, result: "conforming", evidenceIds: [] }));
		expect(TURNOVER_CHECKS).toHaveLength(18);
		expect(businessCheckErrors(dataset)).toEqual([]);
		expect(
			generateReportDraft(dataset).blockers.filter((message) => message.startsWith("control-summary:")),
		).toHaveLength(12);
		dataset.checks = TURNOVER_CHECKS.map(
			(code) =>
				originalChecks.find((check) => check.code === code) ?? { code, result: "conforming", evidenceIds: [] },
		);
		expect(generateReportDraft(dataset).blockers).toEqual([]);
		expect(JSON.stringify(generateReportDraft(dataset))).not.toContain("附件：反洗钱审计情况");
	});

	it("rejects inconsistent suspicious counts and invalid check counts", async () => {
		const { dataset } = await loadSourceDataset();
		if (!dataset.aml) throw new Error("test needs AML data");
		dataset.aml.keySuspiciousTransactionCount = 1;
		dataset.checks = dataset.checks?.map((c, i) => (i === 0 ? { ...c, sampleCount: 1, exceptionCount: 2 } : c));
		expect(businessCheckErrors(dataset)).toHaveLength(2);
	});
	it("loads real HTTP and XLSX boundaries before generating and scoring", async () => {
		const loaded = await loadSourceDataset();
		expect(loaded.sourceReadTrace.some((item) => item.kind === "http")).toBe(true);
		expect(loaded.sourceReadTrace.some((item) => item.kind === "excel")).toBe(true);
		expect(loaded.requests).toContain("/api/audit/findings/F-001");
		expect(loaded.dataset.task.closingOrganization).toBe("测试证券公司");
		expect(loaded.dataset.operatingMetrics[0]?.points[0]?.value).toBe(120.5);

		const pack = buildFactPack(loaded.dataset);
		const draft = generateReportDraft(loaded.dataset, pack);
		const score = scoreReport(loaded.dataset, pack, draft, {
			processedTaskIds: [loaded.dataset.task.taskId],
			toolsUsed: ["get_report_task", "get_audit_finding_detail", "generate_report_draft"],
			allowedTools: ["get_report_task", "get_audit_finding_detail", "generate_report_draft"],
			usedOpenNetwork: false,
			usedFreeSql: false,
			usedArbitraryFileWrite: false,
			schemaValidated: true,
			runMetadataComplete: true,
			writeIdsScoped: true,
			sensitiveDataMinimized: true,
			archivedByAuthorizedUser: false,
			renderQa: { negativeNumbersRed: true, fontsAndTablesMatchTemplate: true },
		});
		expect(draft.closingOrganization).toBe(loaded.dataset.task.closingOrganization);
		expect(score.strictClaims.sentences.filter((item) => item.value === 0)).toEqual([]);
		expect(getExecutableRubricItemCount()).toBe(108);
	});

	it("binds turnover performance evidence only to the audited subject", async () => {
		const loaded = await loadSourceDataset((fixture) => {
			fixture.绩效考核 = [{ personId: "PERSON-001", year: 2025, rating: "A" }];
		});
		const draft = generateReportDraft({
			...loaded.dataset,
			task: {
				...loaded.dataset.task,
				reportType: "turnover",
				subjectPersonId: "PERSON-001",
				subjectPersonName: "张三",
			},
			performance: [
				...loaded.dataset.performance,
				{ personId: "PERSON-OTHER", year: 2025, rating: "B", evidenceIds: ["E-OTHER-2025"] },
			],
		});
		const performanceParagraph = draft.sections
			.flatMap((section) => section.subsections)
			.flatMap((subsection) => subsection.paragraphs)
			.find((item) => item.paragraphId === "turnover-performance");

		expect(performanceParagraph?.text).toBe("2025年度，公司对张三同志的绩效考核结果为A。");
		expect(performanceParagraph?.evidenceIds).toEqual(
			expect.arrayContaining([...loaded.dataset.performance[0]!.evidenceIds]),
		);
		expect(performanceParagraph?.evidenceIds).not.toContain("E-OTHER-2025");
		expect(loaded.requests.some((request) => request.includes("/api/performance"))).toBe(true);
	});
	it.each(["regular", "consultation", "turnover"] as const)(
		"checks annual performance against source fields for %s",
		async (reportType) => {
			const { dataset } = await loadSourceDataset((fixture) => {
				fixture.绩效考核 = [{ personId: "PERSON-001", year: 2025, rating: "A" }];
			});
			dataset.task.reportType = reportType;
			dataset.task.subjectPersonId = "PERSON-001";
			dataset.task.subjectPersonName = "张三";
			const draft = generateReportDraft(dataset);
			const paragraph = draft.sections
				.flatMap((s) => s.subsections.flatMap((sub) => sub.paragraphs))
				.find(
					(p) => p.paragraphId === (reportType === "turnover" ? "turnover-performance" : "regular-manager-duty"),
				);
			if (!paragraph) throw new Error("Missing performance paragraph");
			const ratings = () =>
				scoreStrictReportClaims(dataset, draft).sentences.filter((s) => s.text.includes("绩效考核结果"));
			expect(ratings()).toHaveLength(1);
			expect(ratings().every((s) => s.value === 1)).toBe(true);
			const original = paragraph.text;
			for (const [before, after] of [
				["结果为A", "结果为B"],
				["2025年度", "2024年度"],
				["张三同志", "李四同志"],
			]) {
				paragraph.text = original.replace(before!, after!);
				expect(ratings().some((s) => s.value === 0)).toBe(true);
			}
			paragraph.text = original;
			const proof = dataset.evidence.find((e) => e.sourceId === "DS-09" && e.sourceField === "rating");
			if (!proof) throw new Error("Missing performance evidence");
			const originalProof = { ...proof };
			for (const field of ["dataVersion", "normalizedValue", "sourceRecordId"] as const) {
				proof[field] = "changed";
				expect(ratings().some((s) => s.value === 0)).toBe(true);
				Object.assign(proof, originalProof);
			}
			paragraph.evidenceIds = paragraph.evidenceIds.filter((id) => id !== proof.evidenceId);
			expect(ratings().some((s) => s.value === 0)).toBe(true);
		},
	);

	it.each(["regular", "consultation"] as const)(
		"binds database duty facts to the %s paragraph",
		async (reportType) => {
			const { dataset } = await loadSourceDataset();
			dataset.task.reportType = reportType;
			const summary = "负责人组织了业务讨论，但两次会议记录未留存。";
			dataset.fixedFacts.managerDutySummary = summary;
			dataset.evidence = [
				...dataset.evidence,
				{
					evidenceId: "duty-summary",
					sourceId: "DS-03",
					sourceRecordId: "evaluation-1",
					sourceField: "summary",
					rawValue: summary,
					normalizedValue: summary,
					asOf: "2025-12-31",
					queryTime: "2026-09-11T00:00:00Z",
					dataVersion: "evaluation-v1",
					fileLocation: "database:audit_subject_evaluation/evaluation-1",
				},
			];
			const draft = generateReportDraft(dataset);
			const paragraph = draft.sections
				.flatMap((s) => s.subsections.flatMap((sub) => sub.paragraphs))
				.find((p) => p.paragraphId === "regular-manager-duty");
			expect(paragraph?.text).toBe(summary);
			expect(paragraph?.evidenceIds).toContain("duty-summary");
			expect(
				scoreStrictReportClaims(dataset, draft).sentences.filter(
					(s) => s.location.includes("regular-manager-duty") && s.value === 0,
				),
			).toEqual([]);
			const document = toAuditReportJavaDocument(dataset, draft);
			expect(document.nodes.find((n) => n.nodeId === "regular-manager-duty")?.citationIds).toContain("duty-summary");
			if (!paragraph) throw new Error("Missing duty paragraph");
			paragraph.text = "负责人落实了全部管理要求。";
			expect(
				scoreStrictReportClaims(dataset, draft).sentences.some(
					(s) => s.location.includes("regular-manager-duty") && s.value === 0,
				),
			).toBe(true);
			paragraph.text = summary;
			paragraph.evidenceIds = paragraph.evidenceIds.filter((id) => id !== "duty-summary");
			expect(
				scoreStrictReportClaims(dataset, draft).sentences.some(
					(s) => s.location.includes("regular-manager-duty") && s.value === 0,
				),
			).toBe(true);
		},
	);

	it.each(["regular", "consultation", "turnover"] as const)(
		"renders a sourced zero historical query without rectification claims for %s",
		async (reportType) => {
			const { dataset } = await loadSourceDataset();
			dataset.task.reportType = reportType;
			dataset.findings = dataset.findings.filter((f) => !f.isHistorical);
			const proof = {
				evidenceId: "history-zero",
				sourceId: "DS-03",
				sourceRecordId: "previous-project",
				sourceField: "previousQueryReturnedRecordCount",
				rawValue: "0",
				normalizedValue: "0",
				dataVersion: "query-v1",
				asOf: "2024-12-31",
				queryTime: "2026-09-11T00:00:00Z",
				fileLocation: "database:audit_finding/query/previous-project",
			};
			dataset.evidence = [...dataset.evidence, proof];
			const draft = generateReportDraft(dataset);
			const paragraphs = draft.sections.flatMap((s) => [
				...s.paragraphs,
				...s.subsections.flatMap((sub) => sub.paragraphs),
			]);
			const paragraph = paragraphs.find(
				(p) =>
					p.paragraphId ===
					(reportType === "turnover" ? "turnover-historical-findings" : "regular-previous-rectification"),
			);
			if (!paragraph) throw new Error("Missing historical query paragraph");
			expect(paragraph.text).toBe("前次审计问题台账查询返回0条记录。");
			expect(paragraph.evidenceIds).toEqual(["history-zero"]);
			const score = () =>
				scoreStrictReportClaims(dataset, draft).sentences.find((s) => s.text.includes("前次审计问题台账查询返回"));
			expect(score()?.value).toBe(1);
			proof.normalizedValue = "1";
			expect(score()?.value).toBe(0);
			proof.normalizedValue = "0";
			paragraph.evidenceIds = [];
			expect(score()?.value).toBe(0);
		},
	);

	it.each(["regular", "consultation", "turnover"] as const)(
		"keeps all risk events and complete branch disclosures for %s",
		async (reportType) => {
			const types = [
				"regulatory-inspection",
				"regulatory-penalty",
				"petition",
				"case",
				"accountability",
				"accountability",
			];
			const { dataset } = await loadSourceDataset((fixture) => {
				fixture.风险事项 = types.map((type, index) => ({
					organizationId: "ORG-001",
					eventId: `EVENT-${index}`,
					type,
					state: "VERIFIED_VALUE",
					description: `事项${index}的原始事实。`,
					regularDescription: `事项${index}的原始事实。相关文书：测试决定${index}。处理结果：已完成记录${index}。`,
				}));
			});
			dataset.task.reportType = reportType;
			const draft = generateReportDraft(dataset);
			const paragraphs = draft.sections.flatMap((s) => [
				...s.paragraphs,
				...s.subsections.flatMap((sub) => sub.paragraphs),
			]);
			for (const [index, type] of types.entries()) {
				const event = dataset.riskEvents.find((e) => e.eventId === `EVENT-${index}`);
				expect(event?.type).toBe(type);
				const matching = paragraphs.filter((p) => p.text.includes(`事项${index}的原始事实。`));
				expect(matching).toHaveLength(1);
				expect(matching[0]?.text).toBe(event?.regularDescription);
				expect(matching[0]?.evidenceIds).toEqual(event?.evidenceIds);
			}
			const document = toAuditReportJavaDocument(dataset, draft);
			for (const event of dataset.riskEvents)
				expect(document.nodes.some((n) => n.text === event.regularDescription)).toBe(true);
		},
	);

	it("builds a Java document with stable paragraph nodes and evidence citations", async () => {
		const loaded = await loadSourceDataset();
		const draft = generateReportDraft(loaded.dataset);
		const document = toAuditReportJavaDocument(loaded.dataset, draft);
		const introductionNode = document.nodes.find((node) => node.nodeId === draft.introduction.paragraphId);

		expect(document.schemaVersion).toBe("audit-report-document.v1");
		expect(new Set(document.nodes.map((node) => node.nodeId)).size).toBe(document.nodes.length);
		expect(introductionNode).toMatchObject({
			nodeType: "paragraph",
			text: draft.introduction.text,
			textEditable: true,
			citationIds: draft.introduction.evidenceIds,
		});
		for (const citationId of introductionNode?.citationIds ?? []) {
			expect(document.citations.some((citation) => citation.citationId === citationId)).toBe(true);
		}
		expect(document.citations.every((citation) => !("matchScore" in citation))).toBe(true);

		const revised = {
			...draft,
			introduction: { ...draft.introduction, text: `${draft.introduction.text}人工修改。` },
		};
		const revisedDocument = toAuditReportJavaDocument(loaded.dataset, revised);
		expect(revisedDocument.structureHash).toBe(document.structureHash);
	});

	it.each([false, true])(
		"runs final consistency gate (tampered=%s)",
		async (tampered) => {
			const loaded = await loadSourceDataset();
			const spec = JSON.parse(await readFile(specPath, "utf8")) as RuntimeSpec;
			await resolveSpecPromptPaths(spec, dirname(specPath));
			const outputContractSchema = JSON.parse(
				await readFile(join(packageRoot, "specs", "audit-report", "output-contract.schema.json"), "utf8"),
			) as unknown;
			const harness = await createFauxHarness();
			cleanups.push(harness.cleanup);
			harness.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("generate_report_draft", {})], { stopReason: "toolUse" }),
				(context) => {
					const message = context.messages.at(-1);
					if (message?.role !== "toolResult") throw new Error("Missing generation result");
					const text = message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("");
					expect(text.length).toBeLessThan(512);
					const reference = JSON.parse(text);
					if (tampered) reference.documentToken = "forged";
					return fauxAssistantMessage(JSON.stringify(reference));
				},
			]);
			const toolsets = new ToolsetRegistry();
			toolsets.register("audit-report", async () =>
				createBoundAuditReportTools(loaded.dataset, join(packageRoot, "specs", "audit-report", "skills")),
			);
			const runtime = await createSessionRuntime({
				...auditReportDelivery,
				spec,
				profile,
				registry: createDefaultPluginRegistry(),
				toolsets,
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
				outputContractSchema,
				skillPaths: [join(packageRoot, "specs", "audit-report", "skills", "SKILL.md")],
			});
			cleanups.push(runtime.dispose);
			const result = await runtime.run("生成常规审计报告");
			if (tampered) {
				expect(result.status, JSON.stringify(result)).toBe("error");
				return;
			}
			expect(result.status, JSON.stringify(result)).toBe("completed");
			expect(result.output).toContain('"schemaVersion":"audit-report-document.v1"');
			expect(result.output).toContain('"taskId":"TASK-001"');
			expect(result.output).not.toContain("matchScore");
		},
		15000,
	);

	it("keeps documents private and rejects stale, cross-task and forged completion references", async () => {
		const { dataset } = await loadSourceDataset();
		const tools = createBoundAuditReportTools(dataset, join(packageRoot, "specs", "audit-report", "skills"));
		const call = async (name: string, params: Record<string, unknown> = {}) => {
			const tool = tools.find((item) => item.name === name)!;
			return tool.execute("test", params, undefined, undefined, {} as never);
		};
		const ref = (response: Awaited<ReturnType<typeof call>>) =>
			JSON.parse(
				response.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join(""),
			);
		const first = ref(await call("generate_report_draft"));
		expect(Object.keys(first).sort()).toEqual(["documentToken", "schemaVersion", "taskId"]);
		const resolved = ref(await call("resolve_report_document", { referenceJson: JSON.stringify(first) }));
		expect(resolved).toEqual(toAuditReportJavaDocument(dataset, generateReportDraft(dataset)));
		for (const invalid of [
			{ ...first, taskId: "OTHER" },
			{ ...first, extra: true },
			{ ...first, documentToken: "forged" },
		]) {
			await expect(call("resolve_report_document", { referenceJson: JSON.stringify(invalid) })).rejects.toThrow(
				"reference",
			);
		}
		const second = ref(await call("generate_report_draft"));
		expect(second.documentToken).not.toBe(first.documentToken);
		await expect(call("resolve_report_document", { referenceJson: JSON.stringify(first) })).rejects.toThrow(
			"reference",
		);
		await call("begin_report_run");
		await expect(call("resolve_report_document", { referenceJson: JSON.stringify(second) })).rejects.toThrow(
			"reference",
		);
		const spec = JSON.parse(await readFile(specPath, "utf8")) as RuntimeSpec;
		for (const name of ["begin_report_run", "resolve_report_document", "validate_report_document"])
			expect(spec.tools).not.toContain(name);
	});

	it.each(["valid", "historical", "other-project", "other-organization", "missing-citation"])(
		"verifies AML presence against scoped current findings (%s)",
		async (scenario) => {
			const { dataset } = await loadSourceDataset();
			const finding = dataset.findings[0]!;
			dataset.findings = [
				{
					...finding,
					category: "反洗钱工作",
					isHistorical: scenario === "historical",
					projectId: scenario === "other-project" ? "OTHER" : dataset.task.projectId,
					organizationId: scenario === "other-organization" ? "OTHER" : dataset.task.organizationId,
				},
			];
			const draft = generateReportDraft(dataset);
			draft.introduction.text = "审计期内，营业部反洗钱工作存在以下问题：";
			draft.introduction.evidenceIds = scenario === "missing-citation" ? [] : finding.evidenceIds;
			const sentence = scoreStrictReportClaims(dataset, draft).sentences.find(
				(item) => item.text === draft.introduction.text,
			);
			expect(sentence).toBeDefined();
			expect(sentence?.value).toBe(scenario === "valid" ? 1 : 0);
		},
	);

	it("groups only this paragraph's fields by record and keeps versions separate", async () => {
		const { dataset } = await loadSourceDataset();
		const e = dataset.evidence[0];
		if (!e) throw new Error("missing test evidence");
		dataset.evidence = [...dataset.evidence, { ...e, evidenceId: "VERSION-2", dataVersion: "v2" }];
		const draft = generateReportDraft(dataset);
		draft.introduction.evidenceIds = [e.evidenceId, "VERSION-2"];
		const doc = toAuditReportJavaDocument(dataset, draft);
		const node = doc.nodes.find((n) => n.nodeId === draft.introduction.paragraphId)!;
		expect(node.basis?.sourceGroups).toHaveLength(2);
		expect(node.basis?.sourceGroups.flatMap((g) => g.citationIds)).toEqual([e.evidenceId, "VERSION-2"]);
		expect(reportBasisNeedsRecheck(node, node.text)).toBe(false);
		expect(reportBasisNeedsRecheck(node, `${node.text}改动`)).toBe(true);
		expect(doc.nodes.find((n) => n.nodeId === "regular-opinion-lead")?.basis?.kind).toBe("template");
		draft.introduction.evidenceIds = [];
		expect(
			toAuditReportJavaDocument(dataset, draft).nodes.find((n) => n.nodeId === draft.introduction.paragraphId)?.basis
				?.kind,
		).toBe("missing");
	});

	it("rejects duplicate evidence, unknown references and every final-document mutation", async () => {
		const { dataset } = await loadSourceDataset();
		const draft = generateReportDraft(dataset);
		const doc = toAuditReportJavaDocument(dataset, draft);
		const clean = JSON.parse(JSON.stringify(doc));
		expect(reportDocumentMatches(doc, clean)).toBe(true);
		for (const key of [
			"report",
			"nodes",
			"citations",
			"structureHash",
			"matchScore",
			"qualityHints",
			"aiSuggestions",
		]) {
			const changed = { ...clean, [key]: "forged" };
			expect(reportDocumentMatches(doc, changed), key).toBe(false);
		}
		draft.introduction.evidenceIds = ["UNKNOWN"];
		expect(() => toAuditReportJavaDocument(dataset, draft)).toThrow("unknown evidence");
		dataset.evidence = [...dataset.evidence, dataset.evidence[0]!];
		expect(() => toAuditReportJavaDocument(dataset, generateReportDraft(dataset))).toThrow("Duplicate evidence");
	});
});
