import { expect, it } from "vitest";
import type { RunResult } from "../src/runtime/contract.ts";
import { extractJsonBlock, validateOutputContract } from "../src/runtime/output-contract.ts";
import { toWireResult } from "../src/server/routes.ts";

const base: RunResult = {
	runId: "r",
	specId: "demo",
	status: "completed",
	turns: 1,
	durationMs: 1,
	judgeAttempts: {},
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
};

it("does not inject metadata into an already validated answer", () => {
	const sourceDetails = [{ clause_id: "C1", text: "source" }];
	const wire = toWireResult({ ...base, output: '{"ok":true}', sourceDetails });
	expect(wire.answer).toEqual({ ok: true });
	expect(wire.sourceDetails).toEqual(sourceDetails);
});

it.each(["aborted", "error", "limit_exceeded"] as const)("never delivers a prefilled answer for %s", (status) => {
	const input = { ...base, status, answer: { unsafe: true }, output: '{"unsafe":true}' };
	expect(toWireResult(input).answer).toBeUndefined();
	expect(input.answer).toEqual({ unsafe: true });
});

it("does not retain an unrelated answer when the current output cannot be parsed", () => {
	expect(toWireResult({ ...base, output: "plain text", answer: { old: true } }).answer).toBeUndefined();
});

it.each(['[{"ok":true}]', '```json\n[{"ok":true}]\n```'])("validates and delivers the entire array: %s", (output) => {
	expect(
		validateOutputContract(
			output,
			{ type: "array", items: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
			[],
		),
	).toEqual({ ok: true, value: [{ ok: true }] });
	expect(toWireResult({ ...base, output }).answer).toEqual([{ ok: true }]);
	expect(validateOutputContract(output, { type: "object" }, []).ok).toBe(false);
});

it.each(['[{"ok":true}', '[{"ok":true},]'])("does not salvage a nested object from malformed array %s", (output) => {
	expect(extractJsonBlock(output).kind).toBe("unparsable");
	expect(validateOutputContract(output, { type: "object" }, []).ok).toBe(false);
});
