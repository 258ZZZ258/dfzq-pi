import type { RunResult } from "../runtime/contract.ts";
import { verifyDelivery } from "../runtime/delivery.ts";
import { extractJsonBlock } from "../runtime/output-contract.ts";
import type { RunRecord } from "../store/contract.ts";

/** 终态行 → RunResult 形状,给 GET /runs/{runId} 用。 */
export function recordToRunResult(row: RunRecord): RunResult {
	let delivery: RunResult["delivery"];
	if (row.deliveryJson) {
		try {
			delivery = JSON.parse(row.deliveryJson) as RunResult["delivery"];
		} catch {
			delivery = { version: 1, validation: "not_checked", partial: "none", outputHash: "invalid" };
		}
	}
	const usage = row.usageJson
		? (JSON.parse(row.usageJson) as RunResult["usage"])
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	return {
		delivery,
		memoryObservation: delivery?.memoryObservation,
		telemetryIncomplete: delivery?.telemetryIncomplete,
		// Repair counters survive polling/restart through delivery_json; legacy rows have none.
		judgeAttempts: delivery?.judgeAttempts ?? {},
		runId: row.runId,
		specId: row.specId,
		status: row.status as RunResult["status"],
		output: row.output,
		errorMessage: row.errorMessage,
		stopReason: row.stopReason,
		limit: row.limitHit,
		usage,
		turns: row.turns ?? 0,
		sourceDetails: row.sourceDetails,
		durationMs: row.finishedAt && row.startedAt ? row.finishedAt - row.startedAt : 0,
	};
}

export function isTerminal(status: RunRecord["status"]): boolean {
	return status !== "queued" && status !== "running";
}

/** Shape all terminal HTTP exits consistently. Never trust a prefilled answer.
 * Completed JSON is extracted without injecting metadata into its schema.
 * Runtime judges and the production pre-persistence validator own validation;
 * this adapter alone does not prove schema/evidence validity. Text-only tasks
 * may complete without answer. sourceDetails remains a top-level field.
 */
export function toWireResult(result: RunResult): RunResult {
	result = verifyDelivery(result);
	// Never trust a pre-populated answer: derive it only from this result's output.
	if (result.answer !== undefined) {
		result = { ...result };
		delete result.answer;
	}
	if (result.status !== "completed") return result;
	if (result.output === undefined) return result;
	const extracted = extractJsonBlock(result.output);
	// 提取不到就原样返回 —— run 已经完成,拿不到 answer 是降级不是失败。
	if (extracted.kind !== "ok") return result;
	return { ...result, answer: extracted.value };
}
