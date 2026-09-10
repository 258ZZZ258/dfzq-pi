import type { SupervisionIssue, SupervisionTaskDescriptor } from "./contracts.ts";

function month(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{4})(?:-|年)(\d{1,2})月?$/u.exec(value.trim());
	if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return undefined;
	return `${match[1]}-${match[2]!.padStart(2, "0")}`;
}

/** Never merge lawsuits by a similar title, parties, or cause alone. */
export function selectLatestLitigation(
	issues: readonly SupervisionIssue[],
	task: SupervisionTaskDescriptor,
): SupervisionIssue[] {
	const result: SupervisionIssue[] = [];
	const groups = new Map<string, { issue: SupervisionIssue; month: string }[]>();
	for (const issue of issues) {
		if (issue.reportSection !== "internal.daily.litigation") {
			result.push(issue);
			continue;
		}
		const reportMonth = month(issue.fieldValues.reportMonth);
		const monthEnd = reportMonth
			? new Date(Date.UTC(Number(reportMonth.slice(0, 4)), Number(reportMonth.slice(5)), 0))
					.toISOString()
					.slice(0, 10)
			: undefined;
		// Monthly snapshots represent month end, never a state known earlier in that month.
		if (monthEnd && (monthEnd < task.analysisStart || monthEnd > task.analysisEnd)) continue;
		if (reportMonth && (reportMonth < task.analysisStart.slice(0, 7) || reportMonth > task.analysisEnd.slice(0, 7)))
			continue;
		const rawNumber = issue.fieldValues.caseNumber;
		if (
			!reportMonth ||
			typeof rawNumber !== "string" ||
			!rawNumber.trim() ||
			/^(无|暂无|不详|未提供|未知|-|待定)$/u.test(rawNumber.trim())
		) {
			result.push({ ...issue, confirmationStatus: "PENDING_REVIEW" });
			continue;
		}
		const caseNumber = rawNumber.replace(/\s/gu, "").replace(/（/gu, "(").replace(/）/gu, ")");
		const key = JSON.stringify([task.organizationId, caseNumber]);
		const group = groups.get(key) ?? [];
		group.push({ issue, month: reportMonth });
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		const latest = group
			.map((item) => item.month)
			.sort()
			.at(-1)!;
		const matches = group.filter((item) => item.month === latest);
		// Same-month multiple records require resolution; never choose by upload time or input order.
		result.push(
			...matches.map(({ issue }) =>
				matches.length === 1 ? issue : { ...issue, confirmationStatus: "PENDING_REVIEW" as const },
			),
		);
	}
	return result;
}
