import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAuditReportTools } from "./report-tools.ts";

export function createAuditReportExtension(skillRoot: string): ExtensionFactory {
	return (pi) => {
		for (const tool of createAuditReportTools(skillRoot)) {
			pi.registerTool(tool);
		}
	};
}
