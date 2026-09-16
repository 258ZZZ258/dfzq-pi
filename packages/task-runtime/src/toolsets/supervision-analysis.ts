import type { SupervisionAnalysisPayload } from "../supervision-analysis/contracts.ts";
import { convertSupervisionExtractions } from "../supervision-analysis/extraction-adapter.ts";
import { parseSupervisionTask } from "../supervision-analysis/task.ts";
import { createSupervisionAnalysisTools } from "../supervision-analysis/tools.ts";
import { toSupervisionMaterialsFromUploads } from "../supervision-analysis/upload-material-adapter.ts";
import { verifyAndConvertExtractions } from "../supervision-analysis/verify-fields.ts";
import type { ToolsetProvider } from "./registry.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSupervisionAnalysisPayload(value: unknown): SupervisionAnalysisPayload {
	if (!isRecord(value) || !isRecord(value.task)) {
		throw new Error("supervision-analysis requires a payload with task metadata");
	}
	if (typeof value.task.organizationId !== "string" || value.task.organizationId.trim().length === 0) {
		throw new Error("supervision-analysis payload.task.organizationId must identify one selected organization");
	}
	if ("organizationIds" in value.task) {
		throw new Error("supervision-analysis task accepts one organizationId, not organizationIds");
	}
	if ("extractionResults" in value) {
		if (
			["materials", "uploadedMaterials", "issues", "rectifications", "accountabilities"].some((key) => key in value)
		)
			throw new Error("extractionResults cannot be mixed with preassembled records");
		const converted = convertSupervisionExtractions(value.extractionResults, value.categoryMappings);
		return parseSupervisionAnalysisPayload({
			task: value.task,
			snapshotAt: value.snapshotAt,
			continuousAsCompleted: value.continuousAsCompleted,
			...converted,
		});
	}
	if ("uploadedMaterials" in value && "materials" in value) {
		throw new Error("supervision-analysis accepts either materials or uploadedMaterials, not both");
	}
	if ("categoryMappings" in value && !("uploadedMaterials" in value)) {
		throw new Error("categoryMappings requires uploadedMaterials");
	}
	const materials =
		"uploadedMaterials" in value
			? toSupervisionMaterialsFromUploads(value.uploadedMaterials, value.categoryMappings)
			: value.materials;
	if (!Array.isArray(materials)) throw new Error("supervision-analysis payload.materials must be an array");
	const arrays = ["issues", "rectifications", "accountabilities"] as const;
	for (const key of arrays) {
		if (!Array.isArray(value[key])) {
			throw new Error(`supervision-analysis payload.${key} must be an array`);
		}
	}
	if (typeof value.snapshotAt !== "string" || value.snapshotAt.length === 0) {
		throw new Error("supervision-analysis payload.snapshotAt must be a non-empty string");
	}
	const payload = value as unknown as SupervisionAnalysisPayload;
	return {
		task: parseSupervisionTask(payload.task),
		snapshotAt: payload.snapshotAt,
		materials,
		issues: payload.issues,
		rectifications: payload.rectifications,
		accountabilities: payload.accountabilities,
		...(payload.continuousAsCompleted === undefined ? {} : { continuousAsCompleted: payload.continuousAsCompleted }),
	};
}

export function createSupervisionAnalysisToolset(payload: unknown): ToolsetProvider {
	return async () => {
		const parsed = parseSupervisionAnalysisPayload(payload);
		if (isRecord(payload) && "extractionResults" in payload) {
			const converted = await verifyAndConvertExtractions(payload.extractionResults, payload.categoryMappings);
			return createSupervisionAnalysisTools({ ...parsed, ...converted });
		}
		return createSupervisionAnalysisTools(parsed);
	};
}
