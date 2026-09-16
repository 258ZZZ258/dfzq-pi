import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditReportDataset, ReportDraft, ReportFactPack } from "./report-contracts.ts";
import type { ReportNarrativeProcessor } from "./report-narrative-processing.ts";
import type { SemanticState } from "./report-semantic.ts";

export interface ReportToolTrace {
	toolName: string;
	recordIds: readonly string[];
	at: string;
}

export interface AuditReportRequestContext {
	dataset: AuditReportDataset;
	factPack?: ReportFactPack;
	draft?: ReportDraft;
	deliveryToken?: string;
	semantic?: SemanticState;
	narrativeProcessor?: ReportNarrativeProcessor;
	narrativeCache?: { baseline: ReportDraft; result: Awaited<ReturnType<ReportNarrativeProcessor>> };
	trace: ReportToolTrace[];
}

const reportContext = new AsyncLocalStorage<AuditReportRequestContext>();

export function createAuditReportRequestContext(dataset: AuditReportDataset): AuditReportRequestContext {
	return { dataset: structuredClone(dataset), trace: [] };
}

export function withAuditReportRequestContext<T>(
	context: AuditReportRequestContext,
	work: () => Promise<T> | T,
): Promise<T> | T {
	return reportContext.run(context, work);
}

export function requireAuditReportRequestContext(): AuditReportRequestContext {
	const context = reportContext.getStore();
	if (!context) {
		throw new Error("Audit report request context is required");
	}
	return context;
}

export function recordReportToolTrace(toolName: string, recordIds: readonly string[]): void {
	requireAuditReportRequestContext().trace.push({
		toolName,
		recordIds,
		at: new Date().toISOString(),
	});
}
