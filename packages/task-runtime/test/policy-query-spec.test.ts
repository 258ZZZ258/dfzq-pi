import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const specDir = fileURLToPath(new URL("../specs/", import.meta.url));
const spec = JSON.parse(readFileSync(`${specDir}policy-query.json`, "utf8")) as Record<string, unknown>;

describe("出厂 spec: policy-query.json", () => {
	it("ships the output contract through appendSystemPrompt, not buried in system.md", () => {
		expect(spec.appendSystemPrompt).toEqual(["policy-query/output-format.md"]);
	});

	it("no longer carries the output-format section inside system.md", () => {
		const systemMd = readFileSync(`${specDir}policy-query/system.md`, "utf8");
		expect(systemMd).not.toContain("输出格式");
		expect(systemMd).toContain("取证顺序"); // 其余内容还在,不是把文件删空了
	});

	it("keeps the seven legal basis keys and the no-text rule in the appended contract", () => {
		const contract = readFileSync(`${specDir}policy-query/output-format.md`, "utf8");
		for (const key of ["conclusion", "basis", "confidence", "finish_reason"]) {
			expect(contract).toContain(key);
		}
		// basis[] 不得含条款原文 —— 既是权限红线也防篡改(规格 §4.1)。
		expect(contract).toContain("不要");
		expect(contract).toContain("text");
	});

	// output-contract.ts:42-59 那条寄生前提的静态半边:schema 少了这个 required,
	// 反幻觉兜底会静默消失而所有测试照常通过。动态半边是 Task 18 的 A8。
	it("requires clause_id on every basis element — the anti-hallucination carrier", () => {
		const schema = JSON.parse(readFileSync(`${specDir}policy-query/output-contract.schema.json`, "utf8")) as {
			properties: { basis: { items: { required: string[] } } };
		};
		expect(schema.properties.basis.items.required).toContain("clause_id");
	});
});
