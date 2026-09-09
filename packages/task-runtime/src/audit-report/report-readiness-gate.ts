import type { FinalJudge } from "../runtime/final-judge.ts";
import { extractJsonBlock } from "../runtime/output-contract.ts";
import type { PluginDescriptor } from "../runtime/plugin-registry.ts";

export const AUDIT_REPORT_READINESS_PLUGIN_NAME = "audit-report-readiness";

/** A focused stop policy; the output contract remains the authoritative schema validator. */
export const auditReportReadinessDescriptor: PluginDescriptor = {
	name: AUDIT_REPORT_READINESS_PLUGIN_NAME,
	hooks: [],
	factory: (context, options) => {
		const configuredAttempts = options?.maxAttempts;
		const maxAttempts = typeof configuredAttempts === "number" ? configuredAttempts : 1;
		const judge: FinalJudge = {
			name: AUDIT_REPORT_READINESS_PLUGIN_NAME,
			maxAttempts,
			onExhausted: "error",
			async judge({ lastAssistantText }) {
				const extracted = extractJsonBlock(lastAssistantText);
				if (extracted.kind === "ok" && typeof extracted.value === "object" && extracted.value !== null) {
					const value = extracted.value as Record<string, unknown>;
					const report = value.report;
					if (
						value.schemaVersion === "audit-report-document.v1" &&
						typeof report === "object" &&
						report !== null &&
						typeof (report as Record<string, unknown>).taskId === "string" &&
						Array.isArray((report as Record<string, unknown>).sections) &&
						Array.isArray(value.nodes) &&
						Array.isArray(value.citations)
					) {
						const checked = await context.callTool("validate_report_document", {
							documentJson: JSON.stringify(value),
						});
						if (typeof checked === "object" && checked !== null && "valid" in checked && checked.valid === true)
							return { ok: true };
					}
				}
				return {
					ok: false,
					followUp: "请完成取数和规则生成，只输出工具返回的完整 audit-report-document.v1 JSON，不要输出过程说明。",
					detail:
						"final document is incomplete or differs from the current tool-generated report, nodes or sources",
				};
			},
		};
		context.registerFinalJudge(judge);
		return { name: AUDIT_REPORT_READINESS_PLUGIN_NAME, factory: () => {} };
	},
};
