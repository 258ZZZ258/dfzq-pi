import { describe, expect, it, vi } from "vitest";
import { collectClauseIds, type FinalJudge, runFinalJudges } from "../src/runtime/final-judge.ts";

/**
 * reprompt 的 mock。形参类型要显式写出来:`vi.fn(async () => {})` 会被推成**零参** mock,
 * 于是 `mock.calls[0]?.[0]` 在 tsgo 下报 TS2493(长度 0 的元组没有下标 0)。
 * 签名与 RejudgeDeps.reprompt 对齐才是本意。
 */
function repromptMock() {
	return vi.fn(async (_text: string) => {});
}

function judge(name: string, verdicts: Array<{ ok: boolean }>, overrides: Partial<FinalJudge> = {}): FinalJudge {
	let call = 0;
	return {
		name,
		maxAttempts: 2,
		onExhausted: "pass",
		judge: async () => {
			const verdict = verdicts[Math.min(call, verdicts.length - 1)];
			call += 1;
			return verdict?.ok ? { ok: true } : { ok: false, followUp: `${name} 不通过`, detail: `${name} detail` };
		},
		...overrides,
	};
}

describe("runFinalJudges", () => {
	it("returns immediately when every judge passes", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: true }]), judge("b", [{ ok: true }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).not.toHaveBeenCalled();
		expect(outcome.errorMessage).toBeUndefined();
		expect(outcome.attempts).toEqual({ a: 0, b: 0 });
	});

	it("dispatches the first failing judge and re-runs all judges after the reprompt", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }, { ok: true }]), judge("b", [{ ok: true }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(1);
		expect(reprompt).toHaveBeenCalledWith("a 不通过");
		expect(outcome.attempts).toEqual({ a: 1, b: 0 });
	});

	it("runs judges in registration order — the first one wins the reprompt", async () => {
		const reprompt = repromptMock();
		await runFinalJudges({
			judges: [judge("first", [{ ok: false }, { ok: true }]), judge("second", [{ ok: false }, { ok: true }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt.mock.calls[0]?.[0]).toBe("first 不通过");
	});

	it("passes over an exhausted judge whose onExhausted is pass", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }], { maxAttempts: 1, onExhausted: "pass" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(1);
		expect(outcome.errorMessage).toBeUndefined();
		expect(outcome.attempts).toEqual({ a: 1 });
	});

	it("reports an error for an exhausted judge whose onExhausted is error", async () => {
		const outcome = await runFinalJudges({
			judges: [judge("c6", [{ ok: false }], { maxAttempts: 2, onExhausted: "error" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt: async () => {},
			shouldStop: () => false,
		});
		expect(outcome.attempts).toEqual({ c6: 2 });
		expect(outcome.errorMessage).toContain("c6 detail");
	});

	it("stops rejudging when shouldStop reports a tripped limit", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => true,
		});
		expect(reprompt).not.toHaveBeenCalled();
		expect(outcome.errorMessage).toBeUndefined();
	});

	// 终止性锁。算法的每轮循环只有两个出口:派发一次 reprompt(把某个判官的 attempts +1),
	// 或者直接 return。attempts 单调递增且被 maxAttempts 封顶,所以循环轮数 ≤ Σ maxAttempts + 1。
	// 这两条用例把那个上界钉死:判官**恒**不通过时 reprompt 次数必须正好等于 Σ maxAttempts,
	// 多一次就是漏了封顶,不收敛就是死循环(timeout 会让它响亮失败而不是挂住 vitest)。
	it("terminates after exactly maxAttempts reprompts when a judge never passes", { timeout: 5000 }, async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("never", [{ ok: false }], { maxAttempts: 3, onExhausted: "pass" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(3);
		expect(outcome.attempts).toEqual({ never: 3 });
		expect(outcome.errorMessage).toBeUndefined();
	});

	it("bounds the total reprompts by the sum of maxAttempts across judges", { timeout: 5000 }, async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [
				judge("a", [{ ok: false }], { maxAttempts: 2, onExhausted: "pass" }),
				judge("b", [{ ok: false }], { maxAttempts: 2, onExhausted: "pass" }),
			],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		// a 先用尽自己的 2 次,被 pass 放过之后才轮到 b 的 2 次 —— 总数 = Σ maxAttempts = 4。
		expect(reprompt).toHaveBeenCalledTimes(4);
		expect(outcome.attempts).toEqual({ a: 2, b: 2 });
	});
});

describe("collectClauseIds", () => {
	it("finds clause_id at any depth, including inside JSON-encoded strings", () => {
		const out = new Set<string>();
		collectClauseIds(
			{
				content: [{ type: "text", text: JSON.stringify({ hits: [{ clause_id: "A-1" }, { clause_id: "A-2" }] }) }],
				nested: { deeper: [{ clause_id: "B-1" }] },
			},
			out,
		);
		expect([...out].sort()).toEqual(["A-1", "A-2", "B-1"]);
	});

	it("ignores non-string and empty clause_id values", () => {
		const out = new Set<string>();
		collectClauseIds({ clause_id: 1 }, out);
		collectClauseIds({ clause_id: "" }, out);
		expect(out.size).toBe(0);
	});

	it("does not recurse forever on a plain string", () => {
		const out = new Set<string>();
		collectClauseIds("just text", out);
		collectClauseIds('"quoted"', out);
		expect(out.size).toBe(0);
	});
});
