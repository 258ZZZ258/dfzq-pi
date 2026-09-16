import type { AuditReportDataset } from "./report-contracts.ts";
import type { ControlSummary } from "./report-control-summary.ts";

export function buildFirstAuditSummary(dataset: AuditReportDataset): ControlSummary {
	const proofs = dataset.evidence.filter((e) => e.sourceId === "DS-03" && e.sourceField === "firstAudit");
	if (proofs.length === 0) return { text: "", evidenceIds: [], errors: [] };
	const proof = proofs[0];
	const valid =
		proofs.length === 1 &&
		proof?.rawValue === "true" &&
		proof.normalizedValue === "true" &&
		proof.sourceRecordId === dataset.task.projectId &&
		Boolean(proof.dataVersion) &&
		!dataset.findings.some((f) => f.isHistorical) &&
		!dataset.evidence.some((e) => e.sourceId === "DS-03" && e.sourceField === "previousQueryReturnedRecordCount");
	return valid
		? { text: "本次为首次审计，无前次审计问题整改情况。", evidenceIds: [proof.evidenceId], errors: [] }
		: { text: "", evidenceIds: [], errors: ["首次审计声明依据无效，或与前次审计记录冲突。"] };
}
