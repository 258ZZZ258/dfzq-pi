import type { AuditReportType } from "../audit-report/report-contracts.ts";
import { loadAuditReportDataset } from "../audit-report/report-data-source.ts";
import type { ReportNarrativeProcessor } from "../audit-report/report-narrative-processing.ts";
import { createBoundAuditReportTools } from "../audit-report/report-tools.ts";
import type { ToolsetProvider } from "./registry.ts";

export interface AuditReportToolsetOptions {
	taskId: string;
	reportType: AuditReportType;
	apiBaseUrl: string;
	operatingWorkbookPath: string;
	skillRoot: string;
	narrativeProcessor?: ReportNarrativeProcessor;
}

/** Resolve source systems once, then bind the immutable dataset to one run. */
export function createAuditReportToolset(options: AuditReportToolsetOptions): ToolsetProvider {
	return async (signal) => {
		signal?.throwIfAborted();
		const loaded = await loadAuditReportDataset({
			signal,
			taskId: options.taskId,
			reportType: options.reportType,
			apiBaseUrl: options.apiBaseUrl,
			operatingWorkbookPath: options.operatingWorkbookPath,
		});
		signal?.throwIfAborted();
		return createBoundAuditReportTools(loaded.dataset, options.skillRoot, options.narrativeProcessor);
	};
}
