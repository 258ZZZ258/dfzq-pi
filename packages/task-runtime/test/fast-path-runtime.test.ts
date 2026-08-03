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

	it("escalates on empty basis", () => {
		// finish_reason:"stop" + basis:[] 已被 C6 的条件约束拦下,这条锁的是「拦得住」
		const got = judgeFastPathOutput(body({ ...GOOD, basis: [] }), SCHEMA, []);
		expect(got.accept).toBe(false);
	});
});
