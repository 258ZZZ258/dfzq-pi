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

describe("judge — empty outcomes must not fabricate a pass", () => {
	// outcomes=[] 时,filter().length===0 在两个判据里都会真空成立 —— 这跟 vacuous
	// 是同一类陷阱,只是发生在「用例数」这一层。必须显式挡住,不能靠 filter 的真空语义兜底。
	it("fails both criteria when no case ran at all, and says so without claiming a pass", () => {
		const verdict = judge([]);
		expect(verdict.criterion1.pass).toBe(false);
		expect(verdict.criterion1.detail).not.toContain("通过");
		expect(verdict.criterion2.pass).toBe(false);
		expect(verdict.criterion2.detail).not.toContain("通过");
	});
});

describe("renderSummary — scope note follows the actual selection mode", () => {
	it("default mode keeps the family-coverage note (accurate for the 5-case subset)", () => {
		const outcomes = [outcome("L1-001")];
		const text = renderSummary(outcomes, judge(outcomes), { mode: "default" });
		expect(text).toContain("族内差异未覆盖");
	});

	it("all mode drops the family-coverage note and states the full 15-case scope", () => {
		const outcomes = [outcome("L1-001")];
		const text = renderSummary(outcomes, judge(outcomes), { mode: "all" });
		expect(text).not.toContain("族内差异未覆盖");
		expect(text).toContain("15 题");
		expect(text).toContain("判据①(15 题全集全部 completed)");
	});

	it("custom mode drops the family-coverage note and claims no family property either way", () => {
		const outcomes = [outcome("L1-001")];
		const text = renderSummary(outcomes, judge(outcomes), { mode: "custom" });
		expect(text).not.toContain("族内差异未覆盖");
		expect(text).not.toContain("5 族全覆盖");
		expect(text).toContain("自定义");
	});
});

describe("renderSummary — never states a bare 判据①/判据② pass claim", () => {
	// 只看「紧跟一个左括号」挡不住括号里塞结论词的伪造写法,例如
	// 「判据①(已通过)」—— 紧邻字符检查对这种写法完全失明。
	// 升级成:逐一找出全文每一处「判据①/②」,每处都必须紧跟 (...) 括号(裸出现依旧违规),
	// 且括号内容不得含「通过/满足/达成」这类结论词 —— 唯一被认可的结论位置是
	// 括号**外**、冒号后的那句(比如「**判据①(5 题子集全部 completed)**:通过 —— ...」),
	// 这里的检查只看括号内,不会误伤那个位置。
	const CONCLUSION_WORDS = ["通过", "满足", "达成"];

	function assertNoBarePassClaim(text: string): void {
		const pattern = /判据([①②])(\([^)]*\))?/g;
		let match: RegExpExecArray | null = pattern.exec(text);
		let checked = 0;
		while (match !== null) {
			checked += 1;
			const marker = `判据${match[1]}`;
			const paren = match[2];
			// 裸出现(后面没有紧跟括号):这本身就是违规,不用往下看括号内容。
			expect(paren, `位置 ${match.index} 的「${marker}」未紧跟限定括号,是裸断言`).toBeDefined();
			for (const word of CONCLUSION_WORDS) {
				expect(
					paren?.includes(word),
					`位置 ${match.index} 的「${marker}${paren}」括号内含结论词「${word}」,疑似伪造的通过断言`,
				).toBe(false);
			}
			match = pattern.exec(text);
		}
		// 防止正则本身失效导致这条断言形同虚设——全文至少要出现过判据①和判据②各一次。
		expect(checked).toBeGreaterThanOrEqual(2);
	}

	it("default mode", () => {
		const outcomes = [outcome("L1-001")];
		assertNoBarePassClaim(renderSummary(outcomes, judge(outcomes), { mode: "default" }));
	});

	it("all mode", () => {
		const outcomes = [outcome("L1-001")];
		assertNoBarePassClaim(renderSummary(outcomes, judge(outcomes), { mode: "all" }));
	});

	it("custom mode", () => {
		const outcomes = [outcome("L1-001")];
		assertNoBarePassClaim(renderSummary(outcomes, judge(outcomes), { mode: "custom" }));
	});
});
