import { expect, it, vi } from "vitest";
import { runFinalJudges } from "../src/runtime/final-judge.ts";

it("does not reset the repair count after resuming", async () => {
	const reprompt = vi.fn(async () => {});
	const result = await runFinalJudges({
		judges: [
			{
				name: "contract",
				maxAttempts: 1,
				onExhausted: "error",
				judge: async () => ({ ok: false, followUp: "fix" }),
			},
		],
		initialAttempts: { contract: 1 },
		getLastAssistantText: () => "bad",
		getClauseIds: () => [],
		shouldStop: () => false,
		reprompt,
	});
	expect(result.errorMessage).toContain("contract");
	expect(reprompt).not.toHaveBeenCalled();
});

it("does not dispatch or count a repair if cancellation arrives during checkpoint persistence", async () => {
	let stopped = false;
	const reprompt = vi.fn(async () => {});
	const result = await runFinalJudges({
		judges: [
			{
				name: "contract",
				maxAttempts: 1,
				onExhausted: "error",
				judge: async () => ({ ok: false, followUp: "fix" }),
			},
		],
		beforeReprompt: async (_text, next) => {
			expect(next.contract).toBe(1);
			stopped = true;
		},
		getLastAssistantText: () => "bad",
		getClauseIds: () => [],
		shouldStop: () => stopped,
		reprompt,
	});
	expect(result.attempts.contract).toBe(0);
	expect(reprompt).not.toHaveBeenCalled();
});
