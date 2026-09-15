import { describe, expect, it } from "vitest";
import type { AuditFinding } from "../src/audit-report/report-contracts.ts";
import { comparePreviousAuditFindings } from "../src/audit-report/report-pipeline.ts";

const policy = "公司《台账管理办法》规定，业务台账应登记完整并及时更新。";
function records(): AuditFinding[] {
	return [
		{
			findingId: "PREV",
			isHistorical: true,
			category: "综合管理",
			subcategory: "台账登记",
			title: "台账管理不规范",
			policyBasis: policy,
			factText: "上期台账缺少经办人员签字。",
		},
		{
			findingId: "CURRENT",
			isHistorical: false,
			category: "综合管理",
			subcategory: "台账登记",
			title: "台账管理不规范",
			policyBasis: policy,
			factText: "本期抽查发现台账仍有经办人员未签字的情况。",
		},
	] as AuditFinding[];
}

describe("historical comparison is invariant to an embedded policy field", () => {
	it.each([0, 1])("preserves the decision when record %s embeds its policy in the fact field", (index) => {
		const source = records();
		const expected = comparePreviousAuditFindings(source);
		expect(expected.needsReview).toHaveLength(1);
		source[index] = { ...source[index]!, policyBasis: "", factText: `${policy}${source[index]!.factText}` };
		const snapshot = structuredClone(source);
		const result = comparePreviousAuditFindings(source);
		expect(result.needsReview.map((p) => [p.previous.findingId, p.current.findingId])).toEqual([["PREV", "CURRENT"]]);
		expect(result.unrectified).toEqual([]);
		expect(source).toEqual(snapshot);
	});
	it.each([
		{ policyBasis: "", factText: "本次仅提及另一制度，未提供原制度正文。" },
		{ policyBasis: "", factText: `审计发现本次台账不完整。参考材料引用：${policy}` },
		{ policyBasis: "另一不同事项的制度。", factText: `${policy}本期存在其他问题。` },
	])("does not infer a policy from a missing, non-leading or conflicting field: %j", (patch) => {
		const source = records();
		source[1] = { ...source[1]!, ...patch };
		const result = comparePreviousAuditFindings(source);
		expect(result.unrectified).toEqual([]);
		expect(result.needsReview).toHaveLength(1);
	});
	it("does not equate different concrete policies merely because titles are equal", () => {
		const source = records();
		source[0] = { ...source[0]!, policyBasis: "人员变动后更新展业信息。", factText: "上期未更新人员信息。" };
		source[1] = { ...source[1]!, policyBasis: "公示各项产品业务收费。", factText: "本期未公示业务收费标准。" };
		expect(comparePreviousAuditFindings(source).unrectified).toEqual([]);
	});
});
