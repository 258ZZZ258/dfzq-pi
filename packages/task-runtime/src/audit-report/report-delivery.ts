import { extractJsonBlock } from "../runtime/output-contract.ts";
import type { CreateSessionRuntimeOptions } from "../runtime/session-runtime.ts";

/** Internal reference never leaves the runtime as a successful business answer. */
export const auditReportDelivery: Pick<CreateSessionRuntimeOptions, "beforeRun" | "resolveOutput"> = {
	beforeRun: async (callTool) => {
		await callTool("begin_report_run", {});
	},
	resolveOutput: async (text, callTool) => {
		const parsed = extractJsonBlock(text);
		if (parsed.kind !== "ok") throw new Error("Report completion reference is not valid JSON");
		const document = await callTool("resolve_report_document", { referenceJson: JSON.stringify(parsed.value) });
		return JSON.stringify(document);
	},
};
