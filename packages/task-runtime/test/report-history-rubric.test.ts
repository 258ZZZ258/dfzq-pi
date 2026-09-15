import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as XLSX from "@e965/xlsx";
import { expect, it } from "vitest";
import { loadAuditReportDataset } from "../src/audit-report/report-data-source.ts";
import { generateReportDraft } from "../src/audit-report/report-pipeline.ts";
import { scoreStrictReportClaims } from "../src/audit-report/report-strict-rubric.ts";
import { type SourceRow, type SourceTables, startAuditReportMockSystem } from "./fixtures/audit-report-mock-system.ts";

it.each(["turnover-historical-findings", "regular-previous-rectification"])(
	"source quotes cannot certify historical judgments in %s",
	async (paragraphId) => {
		const fixture = JSON.parse(
			await readFile(resolve("test/fixtures/audit-report-source.json"), "utf8"),
		) as SourceTables & {
			经营数据: Array<Array<string | number | null>>;
			指标字典: SourceRow[];
			排名参与家数: SourceRow[];
		};
		const root = await mkdtemp(join(tmpdir(), "audit-history-rubric-"));
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(fixture.经营数据), "经营数据");
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixture.指标字典), "指标字典");
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixture.排名参与家数), "排名参与家数");
		const path = join(root, "operating.xlsx");
		await writeFile(path, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
		const tables = { ...fixture } as Record<string, SourceRow[]>;
		delete tables.经营数据;
		delete tables.指标字典;
		delete tables.排名参与家数;
		const mock = await startAuditReportMockSystem(tables);
		try {
			const { dataset } = await loadAuditReportDataset({
				taskId: "TASK-001",
				reportType: "regular",
				apiBaseUrl: mock.baseUrl,
				operatingWorkbookPath: path,
			});
			const draft = generateReportDraft(dataset);
			draft.sections[0]!.paragraphs = [
				...draft.sections[0]!.paragraphs,
				{
					paragraphId,
					text: "上次问题在本次审计中仍然存在，未有效整改。",
					evidenceIds: dataset.evidence.map((e) => e.evidenceId),
					requiresHumanReview: false,
				},
			];
			const score = scoreStrictReportClaims(dataset, draft);
			const claim = score.sentences
				.flatMap((s) => s.claims)
				.find((c) => c.claimId.startsWith("historical-independent-review"));
			expect(claim?.value).toBe(0);
			expect(claim?.evidence.length).toBeGreaterThan(0);
			expect(score.accepted).toBe(false);
		} finally {
			await mock.close();
			if (resolve(root).startsWith(resolve(tmpdir())) && basename(root).startsWith("audit-history-rubric-"))
				await rm(root, { recursive: true, force: true });
		}
	},
);
