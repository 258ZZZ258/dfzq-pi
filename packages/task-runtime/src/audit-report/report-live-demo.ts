import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAuditReportRequestContext, withAuditReportRequestContext } from "./report-context.ts";
import type { AuditReportDataset, AuditReportType } from "./report-contracts.ts";
import { loadAuditReportDataset, type SourceReadTrace } from "./report-data-source.ts";
import { type MockSystemRequestTrace, startMockAuditSystem } from "./report-mock-system.ts";
import { assessSourceCoverage, renderReportMarkdown } from "./report-pipeline.ts";
import { type ReportRunEvidence, scoreReport } from "./report-rubric.ts";
import { createAuditReportSession } from "./report-runtime.ts";

const allowedTools = [
	"read",
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
] as const;

interface ReportJob {
	caseId: string;
	taskId: string;
	reportType: AuditReportType;
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function runCase(
	dataset: AuditReportDataset,
	sourceReadTrace: readonly SourceReadTrace[],
	systemHttpTrace: readonly MockSystemRequestTrace[],
	outputRoot: string,
): Promise<void> {
	const model = getModel("deepseek", "deepseek-v4-flash");
	const session = await createAuditReportSession({
		cwd: process.cwd(),
		model,
		thinkingLevel: "high",
	});
	const context = createAuditReportRequestContext(dataset);
	try {
		await withAuditReportRequestContext(context, () =>
			session.prompt(
				"/skill:audit-report 严格执行 Skill 的完整流程，逐项取得数据并提交待人工复核的结构化审计报告草稿。不得跳过问题详情和风险事项核验。",
			),
		);
	} finally {
		session.dispose();
	}

	if (!context.factPack || !context.draft) {
		throw new Error(`Live agent did not produce a fact pack and draft for ${dataset.caseId}`);
	}

	const toolsUsed = context.trace.map((item) => item.toolName);
	const submitted = toolsUsed.includes("submit_report_draft");
	const runEvidence: ReportRunEvidence = {
		processedTaskIds: [dataset.task.taskId],
		toolsUsed,
		allowedTools,
		usedOpenNetwork: false,
		usedFreeSql: false,
		usedArbitraryFileWrite: false,
		schemaValidated: context.draftSchemaValidated === true,
		runMetadataComplete: true,
		writeIdsScoped: true,
		sensitiveDataMinimized: true,
		archivedByAuthorizedUser: false,
	};
	const score = scoreReport(dataset, context.factPack, context.draft, runEvidence);
	const outputDirectory = resolve(outputRoot, dataset.caseId);
	await mkdir(outputDirectory, { recursive: true });
	await Promise.all([
		writeFile(resolve(outputDirectory, "normalized-source-snapshot.json"), json(dataset)),
		writeFile(resolve(outputDirectory, "source-read-trace.json"), json(sourceReadTrace)),
		writeFile(resolve(outputDirectory, "system-http-trace.json"), json(systemHttpTrace)),
		writeFile(resolve(outputDirectory, "live-model-messages.json"), json(session.messages)),
		writeFile(resolve(outputDirectory, "live-tool-trace.json"), json(context.trace)),
		writeFile(resolve(outputDirectory, "fact-pack.json"), json(context.factPack)),
		writeFile(resolve(outputDirectory, "structured-draft.json"), json(context.draft)),
		writeFile(resolve(outputDirectory, "report.md"), renderReportMarkdown(context.draft)),
		writeFile(resolve(outputDirectory, "rubric-score.json"), json(score)),
		writeFile(resolve(outputDirectory, "strict-claim-score.json"), json(score.strictClaims)),
		writeFile(resolve(outputDirectory, "source-coverage.json"), json(assessSourceCoverage(dataset))),
		writeFile(
			resolve(outputDirectory, "run-metadata.json"),
			json({
				caseId: dataset.caseId,
				provider: model.provider,
				model: model.id,
				thinkingLevel: "high",
				inputMode: "http-system-apis-plus-excel",
				submitted,
				sourceReadCount: sourceReadTrace.length,
				systemHttpRequestCount: systemHttpTrace.length,
				toolCallCount: context.trace.length,
				runAt: new Date().toISOString(),
			}),
		),
	]);
	process.stdout.write(
		`${dataset.caseId}: ${score.passedCount}/${score.applicableCount} (${score.passRate.toFixed(1)}%), submitted=${submitted}, sourceReads=${sourceReadTrace.length}, tools=${context.trace.length}\n`,
	);
}

async function main(): Promise<void> {
	const requestedCase = process.argv[2] ?? "all";
	const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
	const sourceRoot = resolve(process.argv[3] ?? resolve(packageRoot, "fixtures", "audit-report", "source-simulation"));
	const outputRoot = resolve(process.argv[4] ?? resolve(packageRoot, "output", "audit-report-agent-live-sources"));
	const jobs = JSON.parse(await readFile(resolve(sourceRoot, "报告任务输入.json"), "utf8")) as ReportJob[];
	const selected =
		requestedCase === "all"
			? jobs
			: jobs.filter((job) => job.reportType === requestedCase || job.caseId === requestedCase);
	if (selected.length === 0) {
		throw new Error(`Unknown case "${requestedCase}". Use regular, turnover, aml, a caseId, or all.`);
	}

	const system = await startMockAuditSystem(resolve(sourceRoot, "模拟审计系统全量数据.xlsx"));
	try {
		for (const job of selected) {
			const traceStart = system.requestTrace.length;
			const loaded = await loadAuditReportDataset({
				taskId: job.taskId,
				reportType: job.reportType,
				apiBaseUrl: system.baseUrl,
				operatingWorkbookPath: resolve(sourceRoot, "模拟审计系统全量数据.xlsx"),
			});
			await runCase(loaded.dataset, loaded.sourceReadTrace, system.requestTrace.slice(traceStart), outputRoot);
		}
	} finally {
		await system.close();
	}
}

await main();
