import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SpecRouter } from "../src/router/router.ts";
import type { RunResult } from "../src/runtime/contract.ts";
import { loadResultValidator } from "../src/server/output-delivery.ts";
import { recordToRunResult, toWireResult } from "../src/server/routes.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";

const result: RunResult = {
	runId: "r",
	specId: "demo",
	status: "completed",
	output: '{"ok":true}',
	turns: 1,
	durationMs: 1,
	judgeAttempts: {},
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
};

it("persists a structure-only receipt and rejects an output changed after validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "receipt-"));
	let store = createSqliteRunStore(join(dir, "runs.db"));
	try {
		await writeFile(
			join(dir, "schema.data"),
			JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }),
		);
		const router = new SpecRouter([
			{
				id: "demo",
				model: { role: "main" },
				toolset: "demo",
				tools: ["echo"],
				limits: { maxTurns: 5 },
				outputContract: { schema: "schema.data" },
			},
		]);
		const validate = await loadResultValidator(router, dir);
		const checked = validate(result, { runId: "r", specId: "demo" });
		expect(checked.delivery).toMatchObject({ version: 1, validation: "schema_passed" });
		expect(checked.delivery?.schemaHash).toMatch(/^[a-f0-9]{64}$/);
		store.insertQueued({
			runId: "r",
			clientRequestId: "k",
			sessionId: "s",
			taskKind: "demo",
			specId: "demo",
			input: "q",
			filtersJson: "{}",
			createdAt: 1,
		});
		expect(store.recoverStaleRuns(2)).toBe(1);
		const recovered = store.findByRunId("r");
		if (!recovered) throw new Error("missing recovered record");
		expect(toWireResult(recordToRunResult(recovered)).delivery).toMatchObject({
			validation: "not_checked",
			error: { code: "runtime_error" },
		});
		store.finish("r", checked, 2);
		store.close();
		store = createSqliteRunStore(join(dir, "runs.db"));
		const row = store.findByRunId("r");
		if (!row) throw new Error("missing record");
		const restored = recordToRunResult(row);
		expect(restored.delivery).toEqual(checked.delivery);
		expect(toWireResult(restored).answer).toEqual({ ok: true });
		expect(toWireResult(recordToRunResult({ ...row, deliveryJson: "{" })).delivery?.error?.code).toBe(
			"output_integrity_mismatch",
		);
		const tampered = toWireResult({ ...restored, output: '{"ok":false}' });
		expect(tampered).toMatchObject({
			status: "error",
			delivery: { error: { code: "output_integrity_mismatch", retryable: false } },
		});
		expect(tampered.answer).toBeUndefined();
		store.markError("r", "runtime failed", 3);
		const failed = store.findByRunId("r");
		if (!failed) throw new Error("missing failure record");
		expect(toWireResult(recordToRunResult(failed)).delivery).toMatchObject({
			validation: "not_checked",
			error: { code: "runtime_error" },
		});
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("marks old results unverified rather than inventing a successful check", () => {
	expect(toWireResult(result).delivery).toMatchObject({ validation: "legacy_unverified" });
	expect(toWireResult(toWireResult(result)).status).toBe("completed");
});

it.each([
	["aborted", undefined, "cancelled"],
	["limit_exceeded", "maxTurns", "max_turns"],
	["limit_exceeded", "runTimeout", "run_timeout"],
	["error", undefined, "runtime_error"],
] as const)("normalizes %s/%s into a stable failure code", (status, limit, code) => {
	const wire = toWireResult({ ...result, status, limit });
	expect(wire.delivery).toMatchObject({ error: { code, retryable: false }, partial: "diagnostic_only" });
	expect(wire.answer).toBeUndefined();
});
