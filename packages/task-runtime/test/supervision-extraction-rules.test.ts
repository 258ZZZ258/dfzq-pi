import { expect, it } from "vitest";
import { getSupervisionExtractionRules } from "../src/supervision-analysis/rules.ts";

it("retains monthly snapshots during extraction and distinguishes document numbers", () => {
	const rules = getSupervisionExtractionRules();
	const litigation = rules.find((rule) => rule.ruleId === "daily-litigation");
	expect(litigation?.extractFields.find((field) => field.key === "reportMonth")?.description).toContain(
		"保留全部月份",
	);
	for (const rule of rules) {
		const number = rule.extractFields.find((field) => field.key === "documentNumber");
		if (number) expect(number.description).toContain("记录编号、问题编号、台账序号不得作为文号");
	}
});
