import { expect, it } from "vitest";
import { createAuditReportTools } from "../src/audit-report/report-tools.ts";

it("advertises the batch comparison contract and actual editable paragraphs", () => {
	const tools = createAuditReportTools(".");
	const submit = tools.find((tool) => tool.name === "submit_report_semantic_job")!;
	expect(submit.description).toContain("comparisons:[{currentFindingId");
	expect(submit.description).toContain("internalSubitems");
	const read = tools.find((tool) => tool.name === "get_report_semantic_job")!;
	expect(read.description).toContain("ALL current");
	const revise = tools.find((tool) => tool.name === "revise_report_draft")!;
	expect(revise.promptSnippet).not.toContain("or turnover-historical-findings");
});
