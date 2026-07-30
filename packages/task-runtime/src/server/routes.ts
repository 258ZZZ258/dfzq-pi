import type { RunResult } from "../runtime/contract.ts";
import type { RunRecord } from "../store/contract.ts";

/** 终态行 → RunResult 形状,给 GET /runs/{runId} 用。 */
export function recordToRunResult(row: RunRecord): RunResult {
	const usage = row.usageJson
		? (JSON.parse(row.usageJson) as RunResult["usage"])
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	return {
		runId: row.runId,
		specId: row.specId,
		status: row.status as RunResult["status"],
		output: row.output,
		errorMessage: row.errorMessage,
		stopReason: row.stopReason,
		limit: row.limitHit,
		usage,
		turns: row.turns ?? 0,
		durationMs: row.finishedAt && row.startedAt ? row.finishedAt - row.startedAt : 0,
	};
}

export function isTerminal(status: RunRecord["status"]): boolean {
	return status !== "queued" && status !== "running";
}
