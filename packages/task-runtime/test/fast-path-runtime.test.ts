import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judgeFastPathOutput } from "../src/runtime/fast-path-runtime.ts";

const SCHEMA = {
	type: "object",
	required: ["conclusion", "basis", "finish_reason", "confidence"],
	properties: {
		conclusion: { type: "string" },
		finish_reason: { enum: ["stop", "refused"] },
		confidence: { enum: ["high", "medium", "low"] },
		exhausted_scope: { type: "array", items: { type: "string" } },
		basis: {
			type: "array",
			items: { type: "object", required: ["clause_id"], properties: { clause_id: { type: "string" } } },
		},
	},
} as const;

const body = (o: Record<string, unknown>) => "```json\n" + JSON.stringify(o) + "\n```";
const GOOD = { conclusion: "c", finish_reason: "stop", confidence: "high", basis: [{ clause_id: "A-1" }] };

describe("judgeFastPathOutput", () => {
	it("accepts a fully conforming answer", () => {
		expect(judgeFastPathOutput(body(GOOD), SCHEMA, ["A-1"])).toEqual({ accept: true });
	});

	it("escalates when the contract check fails", () => {
		const got = judgeFastPathOutput(body({ ...GOOD, basis: [{ clause_id: "臆造" }] }), SCHEMA, ["A-1"]);
		expect(got.accept).toBe(false);
		if (!got.accept) expect(got.reason).toContain("臆造");
	});

	it("escalates on finish_reason refused", () => {
		const refused = {
			conclusion: "c",
			finish_reason: "refused",
			confidence: "high",
			basis: [],
			exhausted_scope: ["外规"],
		};
		const got = judgeFastPathOutput(body(refused), SCHEMA, []);
		expect(got.accept).toBe(false);
		if (!got.accept) expect(got.reason).toContain("finish_reason");
	});

	it("escalates on confidence low", () => {
		const got = judgeFastPathOutput(body({ ...GOOD, confidence: "low" }), SCHEMA, ["A-1"]);
		expect(got.accept).toBe(false);
		if (!got.accept) expect(got.reason).toContain("confidence");
	});

	it("escalates when stop is paired with an empty basis (caught by criterion 1)", () => {
		// finish_reason:"stop" + basis:[] 被判据 1 的 `checkConditional` 拦下,这条锁的是
		// 「拦得住」,不是判据 4(basis 非空)自己的分支——判据 4 能不能被这条用例走到,
		// 见 src/runtime/fast-path-runtime.ts 判据 4 上方的注释。
		const got = judgeFastPathOutput(body({ ...GOOD, basis: [] }), SCHEMA, []);
		expect(got.accept).toBe(false);
	});
});

// C-4:上面全部用例都用简化 fixture SCHEMA,从未接触出厂 schema —— 这条用出厂 schema 判一份
// 合格答案,确保简化 fixture 与出厂 schema 的行为不会静默分叉。
const shippedSchema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-query/output-contract.schema.json", import.meta.url)), "utf8"),
);

describe("judgeFastPathOutput(出厂 schema)", () => {
	it("accepts a fully conforming answer under the shipped schema", () => {
		expect(judgeFastPathOutput(body(GOOD), shippedSchema, ["A-1"])).toEqual({ accept: true });
	});
});
