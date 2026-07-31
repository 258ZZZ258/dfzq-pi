import { describe, expect, it } from "vitest";
import { judgeProbes, PROBES, type ProbeOutcome, renderProbeSummary } from "../src/eval/limits-probe.ts";

describe("probe set", () => {
	it("covers all four limit kinds exactly once", () => {
		expect(PROBES.map((p) => p.expect).sort()).toEqual(
			["maxCostUsd", "maxTotalTokens", "maxTurns", "runTimeout"].sort(),
		);
	});

	it("uses L3-001 as the multi-turn payload", () => {
		// 载荷必须必然需要多轮工具调用,否则 P1(maxTurns=1)可能一轮答完而不触发
		for (const probe of PROBES) expect(probe.caseId).toBe("L3-001");
	});
});

describe("judgeProbes", () => {
	function outcome(id: string, overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
		return {
			id,
			expected: "maxTurns",
			actualStatus: "limit_exceeded",
			actualLimit: "maxTurns",
			pass: true,
			...overrides,
		};
	}

	it("passes when all four trip with the right kind", () => {
		expect(judgeProbes([outcome("P1"), outcome("P2"), outcome("P3"), outcome("P4")]).pass).toBe(true);
	});

	it("fails when a probe did not trip at all", () => {
		const verdict = judgeProbes([outcome("P2", { actualStatus: "completed", actualLimit: undefined, pass: false })]);
		expect(verdict.pass).toBe(false);
		expect(verdict.detail).toContain("P2");
		expect(verdict.detail).toContain("completed");
	});

	it("fails when the limit kind is misclassified", () => {
		const verdict = judgeProbes([outcome("P1", { expected: "maxTurns", actualLimit: "runTimeout", pass: false })]);
		expect(verdict.pass).toBe(false);
		expect(verdict.detail).toContain("runTimeout");
	});
});

describe("renderProbeSummary", () => {
	it("shows expected versus actual per probe", () => {
		const text = renderProbeSummary([
			{ id: "P1", expected: "maxTurns", actualStatus: "limit_exceeded", actualLimit: "maxTurns", pass: true },
		]);
		expect(text).toContain("P1");
		expect(text).toContain("maxTurns");
	});
});
