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
import { parseReportInput } from "../src/audit-report/report-input.ts";
import { reportBasisNeedsRecheck, reportDocumentMatches } from "../src/audit-report/report-java-contract.ts";
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

async function loadSourceDataset() {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
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
		const { dataset } = await loadSourceDataset();
		dataset.task.reportType = "turnover";
		dataset.task.workflow = { mode: "turnover", matchingCompleted: true, consultationExists: false };
		dataset.checks = TURNOVER_CHECKS.map((code) => ({ code, result: "conforming", evidenceIds: [] }));
		expect(TURNOVER_CHECKS).toHaveLength(18);
		expect(businessCheckErrors(dataset)).toEqual([]);
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
		const loaded = await loadSourceDataset();
		const draft = generateReportDraft({
			...loaded.dataset,
			task: {
				...loaded.dataset.task,
				reportType: "turnover",
				subjectPersonId: "PERSON-SUBJECT",
				subjectPersonName: "张三",
			},
			performance: [
				{ personId: "PERSON-SUBJECT", year: 2025, rating: "A", evidenceIds: ["E-SUBJECT-2025"] },
				{ personId: "PERSON-OTHER", year: 2025, rating: "B", evidenceIds: ["E-OTHER-2025"] },
			],
		});
		const performanceParagraph = draft.sections
			.flatMap((section) => section.subsections)
			.flatMap((subsection) => subsection.paragraphs)
			.find((item) => item.paragraphId === "turnover-performance");

		expect(performanceParagraph?.text).toContain("张三同志绩效考核结果分别为A");
		expect(performanceParagraph?.evidenceIds).toEqual(["E-SUBJECT-2025"]);
	});

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
			const draft = generateReportDraft(loaded.dataset);
			const document = toAuditReportJavaDocument(loaded.dataset, draft);
			const spec = JSON.parse(await readFile(specPath, "utf8")) as RuntimeSpec;
			if (tampered) document.report.introduction.text += "伪造的最终改写。";
			await resolveSpecPromptPaths(spec, dirname(specPath));
			const outputContractSchema = JSON.parse(
				await readFile(join(packageRoot, "specs", "audit-report", "output-contract.schema.json"), "utf8"),
			) as unknown;
			const harness = await createFauxHarness();
			cleanups.push(harness.cleanup);
			harness.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("generate_report_draft", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage(`\`\`\`json\n${JSON.stringify(document)}\n\`\`\``),
				fauxAssistantMessage(`\`\`\`json\n${JSON.stringify(document)}\n\`\`\``),
			]);
			const toolsets = new ToolsetRegistry();
			toolsets.register("audit-report", async () =>
				createBoundAuditReportTools(loaded.dataset, join(packageRoot, "specs", "audit-report", "skills")),
			);
			const runtime = await createSessionRuntime({
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
