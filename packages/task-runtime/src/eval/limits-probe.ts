import type { LimitKind } from "../runtime/contract.ts";

export interface ProbeSpec {
	id: string;
	caseId: string;
	/** 覆盖进 spec.limits 的字段;其余限额留空,保证只有一类会触发。 */
	limits: Record<string, number>;
	expect: LimitKind;
}

/**
 * 四类限额各一次(判据③)。阈值压到必触发。
 *
 * 载荷统一用 L3-001(full_year_audit):它必然需要多轮工具调用,否则 P1 的 maxTurns=1
 * 可能一轮就答完而不触发,探针就变成假阳性。
 *
 * P4 依赖 profile 的 cost 费率非零。阈值取到任何非零成本都触发,所以费率准确性
 * 不影响本探针 —— 只影响「总花费」这个数字(规格 B1:单位是元)。
 */
export const PROBES: readonly ProbeSpec[] = [
	{ id: "P1", caseId: "L3-001", limits: { maxTurns: 1 }, expect: "maxTurns" },
	{ id: "P2", caseId: "L3-001", limits: { runTimeoutMs: 1000 }, expect: "runTimeout" },
	{ id: "P3", caseId: "L3-001", limits: { maxTotalTokens: 100 }, expect: "maxTotalTokens" },
	{ id: "P4", caseId: "L3-001", limits: { maxCostUsd: 0.000001 }, expect: "maxCostUsd" },
];

export interface ProbeOutcome {
	id: string;
	expected: LimitKind;
	actualStatus?: string;
	actualLimit?: string;
	pass: boolean;
}

export function evaluateProbe(spec: ProbeSpec, status?: string, limit?: string): ProbeOutcome {
	return {
		id: spec.id,
		expected: spec.expect,
		actualStatus: status,
		actualLimit: limit,
		pass: status === "limit_exceeded" && limit === spec.expect,
	};
}

export function judgeProbes(outcomes: ProbeOutcome[]): { pass: boolean; detail: string } {
	const failed = outcomes.filter((o) => !o.pass);
	return {
		pass: failed.length === 0 && outcomes.length === PROBES.length,
		detail:
			failed.length === 0
				? `四类限额各触发一次且归类正确(${outcomes.length}/${PROBES.length})`
				: failed
						.map(
							(o) =>
								`${o.id}: 期望 status=limit_exceeded limit=${o.expected},实际 status=${o.actualStatus ?? "—"} limit=${o.actualLimit ?? "—"}`,
						)
						.join("; "),
	};
}

export function renderProbeSummary(outcomes: ProbeOutcome[]): string {
	const rows = outcomes
		.map(
			(o) =>
				`| ${o.id} | ${o.expected} | ${o.actualStatus ?? "—"} | ${o.actualLimit ?? "—"} | ${o.pass ? "pass" : "**FAIL**"} |`,
		)
		.join("\n");
	const verdict = judgeProbes(outcomes);
	return [
		"# 判据③ · 四类限额探针",
		"",
		"| 探针 | 期望 limit | 实际 status | 实际 limit | 结果 |",
		"|---|---|---|---|---|",
		rows,
		"",
		`**判据③**:${verdict.pass ? "通过" : "**不通过**"} —— ${verdict.detail}`,
		"",
	].join("\n");
}
