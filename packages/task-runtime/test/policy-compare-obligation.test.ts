import { describe, expect, it } from "vitest";
import { filterExternalObligationClauses } from "../src/runtime/policy-compare/obligation.ts";

describe("filterExternalObligationClauses", () => {
	it("仅保留含规范性义务或禁止语义的外规条款", () => {
		const clauses = filterExternalObligationClauses([
			{ seq: 0, clausePath: "第一条", text: "本办法适用于上市公司。" },
			{ seq: 1, clausePath: "第二条", text: "上市公司应当及时披露相关事项。" },
			{ seq: 2, clausePath: "第三条", text: "上市公司不得虚假记载。" },
			{ seq: 3, clausePath: "第四条", text: "对应当事人的材料应当妥善保管。" },
			{ seq: 4, clausePath: "第五条", text: "无须重复报送已经披露的材料。" },
		]);

		expect(clauses.map((clause) => clause.seq)).toEqual([1, 2, 3]);
	});
});
