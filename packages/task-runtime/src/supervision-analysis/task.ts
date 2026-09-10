import type { SupervisionTaskDescriptor } from "./contracts.ts";
import { validateAnalysisPeriod } from "./dates.ts";

export function parseSupervisionTask(value: unknown): SupervisionTaskDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("supervision-analysis requires task metadata");
	}
	const task = value as Record<string, unknown>;
	const fields = ["taskId", "organizationId", "analysisStart", "analysisEnd", "analysisDescription"];
	for (const key of Object.keys(task)) {
		if (!fields.includes(key)) throw new Error(`Unsupported supervision task field: ${key}`);
	}
	for (const key of ["taskId", "organizationId", "analysisStart", "analysisEnd"] as const) {
		if (typeof task[key] !== "string" || task[key].trim().length === 0) {
			throw new Error(`supervision-analysis task.${key} must be a non-empty string`);
		}
	}
	if (task.analysisDescription !== undefined && typeof task.analysisDescription !== "string") {
		throw new Error("supervision-analysis task.analysisDescription must be a string");
	}
	const analysisDescription =
		typeof task.analysisDescription === "string" ? task.analysisDescription.trim() : undefined;
	const result: SupervisionTaskDescriptor = {
		taskId: task.taskId as string,
		organizationId: task.organizationId as string,
		analysisStart: task.analysisStart as string,
		analysisEnd: task.analysisEnd as string,
		...(analysisDescription ? { analysisDescription } : {}),
	};
	validateAnalysisPeriod(result);
	return result;
}
