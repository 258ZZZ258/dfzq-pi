import { describe, expect, it } from "vitest";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { validateSpec } from "../src/spec/validate.ts";

function baseSpec(): RuntimeSpec {
	return {
		id: "demo",
		model: { role: "main" },
		toolset: "demo-tools",
		tools: ["echo"],
		limits: { maxTurns: 5 },
	};
}

const ctx = {
	knownToolsets: new Set(["demo-tools"]),
	knownPlugins: new Set(["limits", "result-budget"]),
	knownRoles: new Set(["main"]),
};

describe("validateSpec", () => {
	it("accepts a well-formed spec", () => {
		expect(() => validateSpec(baseSpec(), ctx)).not.toThrow();
	});

	it("rejects an empty tools whitelist", () => {
		const spec = { ...baseSpec(), tools: [] };
		expect(() => validateSpec(spec, ctx)).toThrow(/tools.*non-empty/i);
	});

	it("rejects an unknown toolset", () => {
		const spec = { ...baseSpec(), toolset: "nope" };
		expect(() => validateSpec(spec, ctx)).toThrow(/toolset "nope"/);
	});

	it("rejects an unknown plugin name", () => {
		const spec: RuntimeSpec = { ...baseSpec(), resultPolicy: "does-not-exist" };
		expect(() => validateSpec(spec, ctx)).toThrow(/plugin "does-not-exist"/);
	});

	it("rejects an unbound model role", () => {
		const spec: RuntimeSpec = { ...baseSpec(), model: { role: "judge" } };
		expect(() => validateSpec(spec, ctx)).toThrow(/role "judge"/);
	});

	it("rejects limits with no field set", () => {
		const spec: RuntimeSpec = { ...baseSpec(), limits: {} };
		expect(() => validateSpec(spec, ctx)).toThrow(/at least one limit/i);
	});

	it("rejects an outputContract with an empty schema path", () => {
		const spec: RuntimeSpec = { ...baseSpec(), outputContract: { schema: "" } };
		expect(() => validateSpec(spec, ctx)).toThrow(/outputContract\.schema.*non-empty path/);
	});

	it("rejects an outputContract with a negative maxRepairAttempts", () => {
		const spec: RuntimeSpec = {
			...baseSpec(),
			outputContract: { schema: "answer.schema.json", maxRepairAttempts: -1 },
		};
		expect(() => validateSpec(spec, ctx)).toThrow(/outputContract\.maxRepairAttempts.*non-negative integer/);
	});
});
