import type { SupervisionTaskDescriptor } from "./contracts.ts";

export function isBusinessDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateAnalysisPeriod(task: Pick<SupervisionTaskDescriptor, "analysisStart" | "analysisEnd">): void {
	for (const [name, date] of Object.entries({ analysisStart: task.analysisStart, analysisEnd: task.analysisEnd })) {
		if (!isBusinessDate(date)) throw new Error(`${name} must be a valid YYYY-MM-DD date`);
	}
	if (task.analysisStart > task.analysisEnd) throw new Error("analysisStart must not be after analysisEnd");
}
