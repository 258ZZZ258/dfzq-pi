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
} from "../src/audit-report/index.ts";
import { createBoundAuditReportTools } from "../src/audit-report/report-tools.ts";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
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

	it("runs the full agent loop through ToolsetRegistry and outputContract", async () => {
		const loaded = await loadSourceDataset();
		const draft = generateReportDraft(loaded.dataset);
		const spec = JSON.parse(await readFile(specPath, "utf8")) as RuntimeSpec;
		await resolveSpecPromptPaths(spec, dirname(specPath));
		const outputContractSchema = JSON.parse(
			await readFile(join(packageRoot, "specs", "audit-report", "output-contract.schema.json"), "utf8"),
		) as unknown;
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("generate_report_draft", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``),
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
		expect(result.status).toBe("completed");
		expect(result.output).toContain('"taskId":"TASK-001"');
	});
});
