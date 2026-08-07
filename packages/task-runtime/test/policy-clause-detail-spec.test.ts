import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const specDir = fileURLToPath(new URL("../specs/", import.meta.url));

describe("出厂 spec: policy-clause-detail.json", () => {
	it("uses a dedicated detail contract and only the retrieval tools needed for a clause", () => {
		const spec = JSON.parse(readFileSync(`${specDir}policy-clause-detail.json`, "utf8")) as {
			id: string;
			tools: string[];
			outputContract: { schema: string };
		};
		expect(spec.id).toBe("policy-clause-detail");
		expect(spec.tools).toEqual(["search_policy", "get_clause_detail"]);
		expect(spec.outputContract.schema).toBe("policy-clause-detail/output-contract.schema.json");
	});
});
