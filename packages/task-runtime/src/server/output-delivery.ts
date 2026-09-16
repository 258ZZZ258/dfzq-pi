import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SpecRouter } from "../router/router.ts";
import type { RunResult } from "../runtime/contract.ts";
import { hashSchema, sealDelivery } from "../runtime/delivery.ts";
import { validateOutputShape } from "../runtime/output-contract.ts";

export type ResultValidator = (result: RunResult, identity: { runId: string; specId: string }) => RunResult;

/** Final structural check before persistence. Domain/evidence judges remain in the runtime. */
export async function loadResultValidator(router: SpecRouter, specsDir: string): Promise<ResultValidator> {
	const schemas = new Map<string, unknown>();
	for (const kind of router.taskKinds()) {
		const spec = router.resolve(kind);
		if (spec?.outputContract) {
			schemas.set(spec.id, JSON.parse(await readFile(resolve(specsDir, spec.outputContract.schema), "utf8")));
		}
	}
	return (result, identity) => {
		const schemaHash = schemas.has(identity.specId) ? hashSchema(schemas.get(identity.specId)) : undefined;
		if (result.runId !== identity.runId || result.specId !== identity.specId) {
			return sealDelivery(
				{
					...result,
					...identity,
					status: "error",
					answer: undefined,
					errorMessage: "result_identity_mismatch",
				},
				"not_checked",
				schemaHash,
			);
		}
		if (result.status !== "completed") return sealDelivery(result, "not_checked", schemaHash);
		if (!schemas.has(result.specId)) return sealDelivery(result, "not_requested");
		try {
			const checked = validateOutputShape(result.output ?? "", schemas.get(result.specId));
			if (checked.ok) return sealDelivery(result, "schema_passed", schemaHash);
			return sealDelivery(
				{
					...result,
					status: "error",
					answer: undefined,
					errorMessage: `output_contract_invalid: ${checked.detail}`,
				},
				"schema_failed",
				schemaHash,
			);
		} catch {
			return sealDelivery(
				{ ...result, status: "error", answer: undefined, errorMessage: "output_contract_validation_error" },
				"schema_failed",
				schemaHash,
			);
		}
	};
}
