import { describe, expect, it } from "vitest";
import type { CaseOutcome } from "../src/eval/drive.ts";
import { judge, renderSummary } from "../src/eval/drive.ts";
import type { ReconcileReport } from "../src/observability/reconcile.ts";
import type { RunResult } from "../src/runtime/contract.ts";

function result(status: RunResult["status"] = "completed"): RunResult {
	return {
		runId: "r",
		specId: "blackbox-eval",
		status,
		output: "{}",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.1 },
		turns: 3,
		durationMs: 10,
	};
}

function report(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
	return {
		ok: true,
		piCalls: ["search_policy"],
		mcpCalls: ["search_policy"],
		missingInMcp: [],
		missingInPi: [],
		orderMismatch: false,
		schemaMismatch: false,
		vacuous: false,
		...overrides,
	};
}

function outcome(caseId: string, overrides: Partial<CaseOutcome> = {}): CaseOutcome {
	return { caseId, result: result(), reconcile: report(), cliExitCode: 0, elapsedMs: 5, ...overrides };
}

describe("criterion 1 — every case reaches completed", () => {
	it("passes when all cases are completed", () => {
		const verdict = judge([outcome("L1-001"), outcome("L2-003")]);
		expect(verdict.criterion1.pass).toBe(true);
	});

	it("fails and names the offending case on limit_exceeded", () => {
		const verdict = judge([outcome("L1-001"), outcome("L3-001", { result: result("limit_exceeded") })]);
		expect(verdict.criterion1.pass).toBe(false);
		expect(verdict.criterion1.detail).toContain("L3-001");
		expect(verdict.criterion1.detail).toContain("limit_exceeded");
	});

	it("fails when a case produced no result at all", () => {
		const verdict = judge([outcome("L1-001", { result: undefined, error: "spawn failed", cliExitCode: 1 })]);
		expect(verdict.criterion1.pass).toBe(false);
		expect(verdict.criterion1.detail).toContain("L1-001");
	});
});

describe("criterion 2 — tool calls reconcile", () => {
	it("passes when every report is ok", () => {
		expect(judge([outcome("L1-001")]).criterion2.pass).toBe(true);
	});

	it("fails on schemaMismatch and says the ruler is broken, not the MCP side", () => {
		const verdict = judge([outcome("L1-001", { reconcile: report({ ok: false, schemaMismatch: true }) })]);
		expect(verdict.criterion2.pass).toBe(false);
		expect(verdict.criterion2.detail).toContain("schemaMismatch");
	});

	it("fails on vacuous even though ok would otherwise be true", () => {
		const verdict = judge([
			outcome("L1-001", {
				reconcile: report({ ok: false, vacuous: true, piCalls: [], mcpCalls: [] }),
			}),
		]);
		expect(verdict.criterion2.pass).toBe(false);
		expect(verdict.criterion2.detail).toContain("vacuous");
	});

	it("fails when a reconcile report is missing", () => {
		expect(judge([outcome("L1-001", { reconcile: undefined })]).criterion2.pass).toBe(false);
	});
});

describe("renderSummary", () => {
	it("labels criterion 1 with the subset qualifier, not as the bare criterion", () => {
		const outcomes = ["L1-001", "L2-003", "L3-001", "TRAP-002", "L3-007"].map((id) => outcome(id));
		const text = renderSummary(outcomes, judge(outcomes));
		// 正向钉措辞:标题里必须出现「5 题子集」,判据①那一行必须自带子集限定词。
		expect(text).toContain("**5 题子集**");
		expect(text).toContain("判据①(5 题子集全部 completed)");
	});

	it("lists per-case status and turn count", () => {
		const outcomes = [outcome("L1-001")];
		const text = renderSummary(outcomes, judge(outcomes));
		expect(text).toContain("L1-001");
		expect(text).toContain("completed");
		expect(text).toContain("3");
	});
});
