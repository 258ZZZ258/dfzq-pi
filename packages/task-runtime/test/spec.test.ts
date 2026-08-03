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

// 注意:limits 给 { maxTurns: 5 }(非空),不是 brief 草稿里的 {} —— validateSpec 既有的
// 顶层 "limits must set at least one limit" 校验会在到达 fastPath 校验之前先抛,{} 会让下面
// 四条用例全部因为这条无关的顶层校验失败,fastPath 校验分支根本测不到。
const BASE = {
	id: "s",
	model: { role: "main" },
	toolset: "t",
	tools: ["x"],
	limits: { maxTurns: 5 },
};
const CTX = { knownToolsets: new Set(["t"]), knownPlugins: new Set<string>(), knownRoles: new Set(["main"]) };

describe("fastPath 校验", () => {
	it("accepts a spec without fastPath", () => {
		expect(() => validateSpec(BASE as never, CTX)).not.toThrow();
	});

	it("accepts a well-formed fastPath", () => {
		const spec = {
			...BASE,
			fastPath: {
				enabled: true,
				systemPrompt: "a.md",
				rewritePrompt: "b.md",
				answerPrompt: "c.md",
				maxClauses: 12,
				limits: { maxCostUsd: 0.1 },
			},
		};
		expect(() => validateSpec(spec as never, CTX)).not.toThrow();
	});

	it("rejects fastPath.maxClauses below 1", () => {
		const spec = {
			...BASE,
			fastPath: {
				enabled: true,
				systemPrompt: "a.md",
				rewritePrompt: "b.md",
				answerPrompt: "c.md",
				maxClauses: 0,
				limits: {},
			},
		};
		expect(() => validateSpec(spec as never, CTX)).toThrow(/maxClauses/);
	});

	it("rejects fastPath missing a prompt path", () => {
		const spec = {
			...BASE,
			fastPath: {
				enabled: true,
				systemPrompt: "a.md",
				rewritePrompt: "b.md",
				maxClauses: 12,
				limits: {},
			},
		};
		expect(() => validateSpec(spec as never, CTX)).toThrow(/answerPrompt/);
	});
});
