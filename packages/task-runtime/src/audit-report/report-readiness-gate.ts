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
					if (typeof value.taskId === "string" && Array.isArray(value.sections)) return { ok: true };
				}
				return {
					ok: false,
					followUp: "请完成取数和规则生成，只输出完整 ReportDraft JSON，不要输出过程说明。",
					detail: "final answer is not a complete ReportDraft",
				};
			},
		};
		context.registerFinalJudge(judge);
		return { name: AUDIT_REPORT_READINESS_PLUGIN_NAME, factory: () => {} };
	},
};
