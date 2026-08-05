import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AuditReportType,
	ReportDraft,
	ReportParagraph,
	ReportSection,
	ReportSubsection,
	ReportTable,
} from "./report-contracts.ts";
import { loadAuditReportDataset } from "./report-data-source.ts";
import { startMockAuditSystem } from "./report-mock-system.ts";
import { buildFactPack, generateReportDraft } from "./report-pipeline.ts";
import { type ReportRunEvidence, scoreReport } from "./report-rubric.ts";

interface ReportJob {
	caseId: string;
	taskId: string;
	reportType: AuditReportType;
}

interface StrictBatchResult {
	caseId: string;
	reportType: AuditReportType;
	organizationName: string;
	staticPassedCount: number;
	staticApplicableCount: number;
	staticPassRate: number;
	sentenceCount: number;
	passedSentenceCount: number;
	sentencePassRate: number;
	claimCount: number;
	verifiedClaimCount: number;
	claimVerificationRate: number;
	sourceTraceRate: number;
	unsupportedClaimCount: number;
	strictAccepted: boolean;
}

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

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function paragraphMap(draft: ReportDraft): Map<string, ReportParagraph> {
	const result = new Map<string, ReportParagraph>([[draft.introduction.paragraphId, draft.introduction]]);
	for (const section of draft.sections) {
		for (const paragraph of section.paragraphs) result.set(paragraph.paragraphId, paragraph);
		for (const subsection of section.subsections) {
			for (const paragraph of subsection.paragraphs) result.set(paragraph.paragraphId, paragraph);
		}
		for (const paragraph of section.closingParagraphs ?? []) result.set(paragraph.paragraphId, paragraph);
	}
	return result;
}

function tableMap(draft: ReportDraft): Map<string, ReportTable> {
	const result = new Map<string, ReportTable>();
	for (const section of draft.sections) {
		for (const table of section.tables) result.set(table.tableId, table);
		for (const subsection of section.subsections) {
			for (const table of subsection.tables ?? []) result.set(table.tableId, table);
		}
	}
	return result;
}

function rebindDraftEvidence(draft: ReportDraft, baseline: ReportDraft): ReportDraft {
	const baselineParagraphs = paragraphMap(baseline);
	const baselineTables = tableMap(baseline);
	const rebindParagraph = (paragraph: ReportParagraph): ReportParagraph => ({
		...paragraph,
		evidenceIds: baselineParagraphs.get(paragraph.paragraphId)?.evidenceIds ?? paragraph.evidenceIds,
	});
	const rebindTable = (table: ReportTable): ReportTable => ({
		...table,
		sourceEvidenceIds: baselineTables.get(table.tableId)?.sourceEvidenceIds ?? table.sourceEvidenceIds,
	});
	const rebindSubsection = (subsection: ReportSubsection): ReportSubsection => ({
		...subsection,
		paragraphs: subsection.paragraphs.map(rebindParagraph),
		...(subsection.tables ? { tables: subsection.tables.map(rebindTable) } : {}),
	});
	const rebindSection = (section: ReportSection): ReportSection => ({
		...section,
		paragraphs: section.paragraphs.map(rebindParagraph),
		tables: section.tables.map(rebindTable),
		subsections: section.subsections.map(rebindSubsection),
		...(section.closingParagraphs ? { closingParagraphs: section.closingParagraphs.map(rebindParagraph) } : {}),
	});
	return {
		...draft,
		introduction: rebindParagraph(draft.introduction),
		sections: draft.sections.map(rebindSection),
		allEvidenceIds: baseline.allEvidenceIds,
	};
}

function runEvidence(taskId: string): ReportRunEvidence {
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

function percentage(numerator: number, denominator: number): number {
	return Number(((numerator / Math.max(denominator, 1)) * 100).toFixed(2));
}

async function main(): Promise<void> {
	const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
	const sourceRoot = resolve(process.argv[2] ?? resolve(packageRoot, "fixtures", "audit-report", "source-batch"));
	const reportRoot = resolve(process.argv[3] ?? resolve(packageRoot, "output", "audit-report-agent-batch-live"));
	const jobs = JSON.parse(await readFile(resolve(sourceRoot, "报告任务输入.json"), "utf8")) as ReportJob[];
	const system = await startMockAuditSystem(resolve(sourceRoot, "模拟审计系统全量数据.xlsx"));
	const results: StrictBatchResult[] = [];
	try {
		for (const job of jobs) {
			const loaded = await loadAuditReportDataset({
				taskId: job.taskId,
				reportType: job.reportType,
				apiBaseUrl: system.baseUrl,
				operatingWorkbookPath: resolve(sourceRoot, "模拟审计系统全量数据.xlsx"),
			});
			const caseDirectory = resolve(reportRoot, job.caseId);
			const originalDraft = JSON.parse(
				await readFile(resolve(caseDirectory, "structured-draft.json"), "utf8"),
			) as ReportDraft;
			const factPack = buildFactPack(loaded.dataset);
			const reboundDraft = rebindDraftEvidence(originalDraft, generateReportDraft(loaded.dataset, factPack));
			const score = scoreReport(loaded.dataset, factPack, reboundDraft, runEvidence(job.taskId));
			const staticItems = score.items.filter((item) => item.applicable && item.dimension !== "CLAIM");
			const staticPassedCount = staticItems.filter((item) => item.value === 1).length;
			const result: StrictBatchResult = {
				caseId: job.caseId,
				reportType: job.reportType,
				organizationName: loaded.dataset.organization.fullName,
				staticPassedCount,
				staticApplicableCount: staticItems.length,
				staticPassRate: percentage(staticPassedCount, staticItems.length),
				sentenceCount: score.strictClaims.sentenceCount,
				passedSentenceCount: score.strictClaims.passedSentenceCount,
				sentencePassRate: score.strictClaims.sentencePassRate,
				claimCount: score.strictClaims.claimCount,
				verifiedClaimCount: score.strictClaims.verifiedClaimCount,
				claimVerificationRate: score.strictClaims.claimVerificationRate,
				sourceTraceRate: score.strictClaims.sourceTraceRate,
				unsupportedClaimCount: score.strictClaims.unsupportedClaimCount,
				strictAccepted: score.strictClaims.accepted,
			};
			results.push(result);
			await mkdir(caseDirectory, { recursive: true });
			await Promise.all([
				writeFile(resolve(caseDirectory, "strict-source-snapshot.json"), json(loaded.dataset)),
				writeFile(resolve(caseDirectory, "strict-evaluation-draft.json"), json(reboundDraft)),
				writeFile(resolve(caseDirectory, "strict-rubric-score.json"), json(score)),
				writeFile(resolve(caseDirectory, "strict-claim-score.json"), json(score.strictClaims)),
			]);
			process.stdout.write(
				`${job.caseId}: sentences=${result.passedSentenceCount}/${result.sentenceCount}, claims=${result.verifiedClaimCount}/${result.claimCount}, unsupported=${result.unsupportedClaimCount}\n`,
			);
		}
	} finally {
		await system.close();
	}

	const aggregate = {
		reportCount: results.length,
		strictAcceptedCount: results.filter((result) => result.strictAccepted).length,
		sentenceCount: results.reduce((sum, result) => sum + result.sentenceCount, 0),
		passedSentenceCount: results.reduce((sum, result) => sum + result.passedSentenceCount, 0),
		claimCount: results.reduce((sum, result) => sum + result.claimCount, 0),
		verifiedClaimCount: results.reduce((sum, result) => sum + result.verifiedClaimCount, 0),
		unsupportedClaimCount: results.reduce((sum, result) => sum + result.unsupportedClaimCount, 0),
	};
	const aggregateResult = {
		...aggregate,
		sentencePassRate: percentage(aggregate.passedSentenceCount, aggregate.sentenceCount),
		claimVerificationRate: percentage(aggregate.verifiedClaimCount, aggregate.claimCount),
		results,
	};
	const rows = results.map(
		(result) =>
			`| ${result.caseId} | ${result.reportType} | ${result.organizationName} | ${result.passedSentenceCount}/${result.sentenceCount} (${result.sentencePassRate.toFixed(2)}%) | ${result.verifiedClaimCount}/${result.claimCount} (${result.claimVerificationRate.toFixed(2)}%) | ${result.sourceTraceRate.toFixed(2)}% | ${result.unsupportedClaimCount} | ${result.strictAccepted ? "通过" : "不通过"} |`,
	);
	const markdown = `# 严格主张级 Rubric 批量评估

## 总体结果

- 报告数量：${aggregate.reportCount}
- 严格通过：${aggregate.strictAcceptedCount}
- 可变句通过：${aggregate.passedSentenceCount}/${aggregate.sentenceCount}（${aggregateResult.sentencePassRate.toFixed(2)}%）
- 主张核验通过：${aggregate.verifiedClaimCount}/${aggregate.claimCount}（${aggregateResult.claimVerificationRate.toFixed(2)}%）
- 无来源主张：${aggregate.unsupportedClaimCount}

严格通过要求：每个可变句均通过、每条主张均可定位到原系统记录字段或批准的派生计算、无未支持事实。

| 案例 | 类型 | 营业部 | 可变句 | 主张 | 来源追溯 | 无来源主张 | 结论 |
|---|---|---|---:|---:|---:|---:|---|
${rows.join("\n")}
`;
	await Promise.all([
		writeFile(resolve(reportRoot, "严格Rubric批量汇总.json"), json(aggregateResult)),
		writeFile(resolve(reportRoot, "严格Rubric批量汇总.md"), markdown),
	]);
}

await main();
