import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditReportDataset, AuditReportType, RubricScore, SourceCoverageAssessment } from "./report-contracts.ts";
import { loadAuditReportDataset } from "./report-data-source.ts";
import { startMockAuditSystem } from "./report-mock-system.ts";
import { assessSourceCoverage, buildFactPack, generateReportDraft, renderReportMarkdown } from "./report-pipeline.ts";
import { type ReportRunEvidence, scoreReport } from "./report-rubric.ts";

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

interface DemoResult {
	caseId: string;
	reportType: string;
	status: string;
	score: RubricScore;
	coverage: SourceCoverageAssessment;
	failedItemIds: readonly string[];
	outputDirectory: string;
}

function runEvidence(dataset: AuditReportDataset): ReportRunEvidence {
	return {
		processedTaskIds: [dataset.task.taskId],
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

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function runCase(dataset: AuditReportDataset, outputRoot: string): Promise<DemoResult> {
	const caseDirectory = resolve(outputRoot, dataset.caseId);
	await mkdir(caseDirectory, { recursive: true });
	const factPack = buildFactPack(dataset);
	const draft = generateReportDraft(dataset, factPack);
	const coverage = assessSourceCoverage(dataset);
	const score = scoreReport(dataset, factPack, draft, runEvidence(dataset));
	const failedItems = score.items.filter((item) => item.applicable && item.value === 0);
	await Promise.all([
		writeFile(resolve(caseDirectory, "normalized-source-snapshot.json"), json(dataset)),
		writeFile(resolve(caseDirectory, "fact-pack.json"), json(factPack)),
		writeFile(resolve(caseDirectory, "structured-draft.json"), json(draft)),
		writeFile(resolve(caseDirectory, "report.md"), renderReportMarkdown(draft)),
		writeFile(resolve(caseDirectory, "rubric-score.json"), json(score)),
		writeFile(resolve(caseDirectory, "strict-claim-score.json"), json(score.strictClaims)),
		writeFile(resolve(caseDirectory, "source-coverage.json"), json(coverage)),
	]);
	return {
		caseId: dataset.caseId,
		reportType: dataset.task.reportType,
		status: draft.status,
		score,
		coverage,
		failedItemIds: failedItems.map((item) => item.id),
		outputDirectory: caseDirectory,
	};
}

async function main(): Promise<void> {
	const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
	const sourceRoot = resolve(process.argv[2] ?? resolve(packageRoot, "fixtures", "audit-report", "source-simulation"));
	const outputRoot = resolve(process.argv[3] ?? resolve(packageRoot, "output", "audit-report-agent-source-demo"));
	await mkdir(outputRoot, { recursive: true });
	const jobs = JSON.parse(await readFile(resolve(sourceRoot, "报告任务输入.json"), "utf8")) as ReportJob[];
	const system = await startMockAuditSystem(resolve(sourceRoot, "模拟审计系统全量数据.xlsx"));
	const results: DemoResult[] = [];
	try {
		for (const job of jobs) {
			const loaded = await loadAuditReportDataset({
				taskId: job.taskId,
				reportType: job.reportType,
				apiBaseUrl: system.baseUrl,
				operatingWorkbookPath: resolve(sourceRoot, "模拟审计系统全量数据.xlsx"),
			});
			results.push(await runCase(loaded.dataset, outputRoot));
			await writeFile(resolve(outputRoot, job.caseId, "source-read-trace.json"), json(loaded.sourceReadTrace));
		}
	} finally {
		await system.close();
	}
	await writeFile(resolve(outputRoot, "evaluation-results.json"), json(results));
	process.stdout.write(
		`${JSON.stringify(
			results.map((item) => ({
				caseId: item.caseId,
				score: item.score.passRate,
				accepted: item.score.accepted,
				sourceDesignCoverage: item.coverage.designCoverage,
				productionReadiness: item.coverage.productionReadiness,
			})),
			null,
			2,
		)}\n`,
	);
}

await main();
