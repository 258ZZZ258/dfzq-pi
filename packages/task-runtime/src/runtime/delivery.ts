import { createHash } from "node:crypto";
import type { DeliveryReceipt, RunResult } from "./contract.ts";

export function hashSchema(schema: unknown): string {
	return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

function digest(result: RunResult, validation: DeliveryReceipt["validation"], schemaHash?: string): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				runId: result.runId,
				specId: result.specId,
				status: result.status,
				output: result.output ?? null,
				limit: result.limit ?? null,
				errorMessage: result.errorMessage ?? null,
				validation,
				schemaHash: schemaHash ?? null,
			}),
		)
		.digest("hex");
}

function failure(result: RunResult): DeliveryReceipt["error"] {
	if (result.status === "completed") return undefined;
	let code: NonNullable<DeliveryReceipt["error"]>["code"] = "runtime_error";
	if (result.status === "aborted") code = "cancelled";
	else if (result.status === "limit_exceeded" && result.limit === "maxTurns") code = "max_turns";
	else if (result.status === "limit_exceeded" && result.limit === "runTimeout") code = "run_timeout";
	else if (
		result.errorMessage?.startsWith("output-contract:") ||
		result.errorMessage?.startsWith("output_contract_invalid:")
	)
		code = "output_contract_invalid";
	else
		for (const known of [
			"assembly_timeout",
			"result_identity_mismatch",
			"output_contract_validation_error",
			"output_integrity_mismatch",
		] as const) {
			if (result.errorMessage === known) code = known;
		}
	return { code, retryable: false };
}

export function sealDelivery(
	result: RunResult,
	validation: DeliveryReceipt["validation"],
	schemaHash?: string,
): RunResult {
	return {
		...result,
		delivery: {
			judgeAttempts: result.judgeAttempts,
			memoryObservation: result.memoryObservation,
			telemetryIncomplete: result.telemetryIncomplete,
			version: 1,
			validation,
			schemaHash,
			outputHash: digest(result, validation, schemaHash),
			partial: result.status !== "completed" && Boolean(result.output) ? "diagnostic_only" : "none",
			error: failure(result),
		},
	};
}

export function sealFailure(
	identity: { runId: string; specId: string; output?: string; limit?: RunResult["limit"] },
	message: string,
): DeliveryReceipt {
	return sealDelivery(
		{
			...identity,
			status: "error",
			errorMessage: message,
			turns: 0,
			durationMs: 0,
			judgeAttempts: {},
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		},
		"not_checked",
	).delivery as DeliveryReceipt;
}

/** Detect stale/corrupt bindings; this checksum is not a signature against a malicious store. */
export function verifyDelivery(result: RunResult): RunResult {
	const receipt = result.delivery;
	if (
		!receipt ||
		(receipt.version === 1 && receipt.validation === "legacy_unverified" && receipt.outputHash === undefined)
	)
		return {
			...result,
			delivery: {
				version: 1,
				validation: "legacy_unverified",
				partial: result.status !== "completed" && Boolean(result.output) ? "diagnostic_only" : "none",
				error: failure(result),
			},
		};
	if (
		receipt.version !== 1 ||
		!["schema_passed", "schema_failed", "not_requested", "not_checked"].includes(receipt.validation) ||
		receipt.outputHash !== digest(result, receipt.validation, receipt.schemaHash) ||
		(receipt.validation === "schema_passed" && !receipt.schemaHash)
	) {
		return sealDelivery(
			{ ...result, status: "error", answer: undefined, limit: undefined, errorMessage: "output_integrity_mismatch" },
			"not_checked",
		);
	}
	// Error and partial flags are derived rather than trusted from serialized metadata.
	return sealDelivery(result, receipt.validation, receipt.schemaHash);
}
