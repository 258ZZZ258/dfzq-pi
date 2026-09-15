import { expect, it } from "vitest";
import { isTitleOnlyFact } from "../src/audit-report/report-fact-text.ts";

it.each(["", "信息公示不完整", "上一次审计发现，营业部存在“信息公示不完整”问题。", "审计发现，营业部信息公示不完整。"])(
	"rejects title-only historical facts: %s",
	(text) => {
		expect(isTitleOnlyFact(text, "信息公示不完整")).toBe(true);
	},
);

it("preserves concrete short facts and facts containing the heading", () => {
	expect(isTitleOnlyFact("经纪人员姓名没有公示。", "信息公示不完整")).toBe(false);
	expect(isTitleOnlyFact("信息公示不完整，缺少经纪人员姓名。", "信息公示不完整")).toBe(false);
});
