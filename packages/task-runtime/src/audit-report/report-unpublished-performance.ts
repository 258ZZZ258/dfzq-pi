import type { AuditReportDataset } from "./report-contracts.ts";
import type { ControlSummary } from "./report-control-summary.ts";

/** Explicit source declaration only; an empty ratings array is never a declaration. */
export function buildUnpublishedPerformanceSummary(
	dataset: Pick<AuditReportDataset, "task" | "performance" | "performanceAvailability" | "evidence">,
): ControlSummary {
	const value = dataset.performanceAvailability;
	const errors: string[] = [];
	const ids: string[] = [];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "evidenceIds,periodEnd,periodStart,personId,status" ||
		value.status !== "not-published" ||
		dataset.task.reportType !== "turnover" ||
		value.personId !== dataset.task.subjectPersonId ||
		!value.personId ||
		dataset.performance.length !== 0 ||
		!Array.isArray(value.evidenceIds) ||
		value.evidenceIds.length === 0
	)
		errors.push("performanceAvailability: 暂无年度考核声明无效或与已有评级冲突。");
	if (!errors.length && value) {
		for (const date of [value.periodStart, value.periodEnd]) {
			if (
				typeof date !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
				!Number.isFinite(Date.parse(date)) ||
				new Date(date).toISOString().slice(0, 10) !== date
			)
				errors.push("performanceAvailability: 声明区间无效。");
		}
		if (value.periodStart > value.periodEnd) errors.push("performanceAvailability: 声明区间倒置。");
		const fields = [
			["DS-09", "noPublishedAnnualResults", "not-published"],
			["DS-03", "personId", value.personId],
			["DS-03", "responsibilityStart", value.periodStart],
			["DS-03", "responsibilityEnd", value.periodEnd],
		] as const;
		const proofs = fields.flatMap(([source, field, expected]) => {
			const matches = dataset.evidence.filter(
				(e) =>
					value.evidenceIds.includes(e.evidenceId) &&
					e.sourceId === source &&
					e.sourceField === field &&
					e.normalizedValue === expected &&
					e.rawValue === (field === "noPublishedAnnualResults" ? "true" : expected),
			);
			if (matches.length !== 1) errors.push(`performanceAvailability: ${field}缺少唯一原始依据。`);
			return matches;
		});
		if (
			proofs.length !== 4 ||
			proofs.some((e) => !e.sourceRecordId || !e.dataVersion) ||
			new Set(proofs.map((e) => e.sourceRecordId)).size !== 1 ||
			new Set(proofs.map((e) => e.dataVersion)).size !== 1
		)
			errors.push("performanceAvailability: 声明与人员区间依据不属于同一对象版本。");
		ids.push(...proofs.map((e) => e.evidenceId));
	}
	return {
		text: errors.length ? "" : "任期内尚无已发布的年度考核结果。",
		evidenceIds: errors.length ? [] : ids,
		errors,
	};
}
