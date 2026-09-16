import { expect, it } from "vitest";
import { buildPerformanceSummary } from "../src/audit-report/report-performance.ts";

type Input = Parameters<typeof buildPerformanceSummary>[0];
function source(entries: Array<[string, string, number, string]>): Input {
	const evidence: Input["evidence"][number][] = [];
	const appointments = [...new Map(entries.map(([id, name]) => [id, name])).entries()].map(
		([personId, personName]) => {
			evidence.push({
				evidenceId: `name-${personId}`,
				sourceId: "DS-02",
				sourceRecordId: personId,
				sourceField: "personName",
				normalizedValue: personName,
				rawValue: personName,
				dataVersion: "person-v1",
				asOf: "2025-12-31",
				queryTime: "2026-01-01T00:00:00Z",
			});
			return { personId, personName, evidenceIds: [`name-${personId}`] };
		},
	);
	const performance = entries.map(([personId, , year, rating]) => {
		const row = { personId, year, rating, evidenceIds: [] as string[] };
		for (const field of ["personId", "year", "rating"] as const) {
			const id = `${personId}-${year}-${field}`;
			row.evidenceIds.push(id);
			evidence.push({
				evidenceId: id,
				sourceId: "DS-09",
				sourceRecordId: `${personId}-${year}`,
				sourceField: field,
				rawValue: String(row[field]),
				normalizedValue: String(row[field]),
				dataVersion: "rating-v1",
				asOf: "2025-12-31",
				queryTime: "2026-01-01T00:00:00Z",
			});
		}
		return row;
	});
	return { task: { reportType: "regular" }, appointments, performance, evidence } as unknown as Input;
}
it("sorts contiguous annual ratings and groups equal results", () => {
	const input = source([
		["P", "甲", 2025, "B"],
		["P", "甲", 2024, "A"],
	]);
	expect(buildPerformanceSummary(input).text).toBe("2024—2025年度，公司对甲同志的绩效考核结果分别为A、B。");
	expect(
		buildPerformanceSummary(
			source([
				["P", "甲", 2024, "A"],
				["P", "甲", 2025, "A"],
			]),
		).text,
	).toContain("均为A");
});
it("does not invent missing intermediate years or combine people", () => {
	const result = buildPerformanceSummary(
		source([
			["P", "甲", 2023, "A"],
			["P", "甲", 2025, "B"],
			["Q", "乙", 2025, "C"],
		]),
	);
	expect(result.text).toBe(
		"2023年度，公司对甲同志的绩效考核结果为A。2025年度，公司对甲同志的绩效考核结果为B。2025年度，公司对乙同志的绩效考核结果为C。",
	);
	expect(result.evidenceIds).toContain("name-Q");
});
it.each(["duplicate", "rating", "version", "name", "other-subject"])("rejects inconsistent input: %s", (failure) => {
	const input = source([["P", "甲", 2025, "B"]]);
	if (failure === "duplicate") input.performance = [...input.performance, input.performance[0]!];
	if (failure === "rating") input.performance[0]!.rating = "A";
	if (failure === "version")
		input.evidence = input.evidence.map((e) => (e.sourceField === "rating" ? { ...e, dataVersion: "changed" } : e));
	if (failure === "name") input.appointments[0]!.personName = "乙";
	if (failure === "other-subject")
		input.task = { ...input.task, reportType: "turnover", subjectPersonId: "Q", subjectPersonName: "乙" };
	expect(buildPerformanceSummary(input).text).toBe("");
	expect(buildPerformanceSummary(input).errors.length).toBeGreaterThan(0);
});
