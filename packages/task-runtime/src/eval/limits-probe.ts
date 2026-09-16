import type { LimitKind } from "../runtime/contract.ts";

export interface ProbeSpec {
	id: string;
	caseId: string;
	/** 覆盖进 spec.limits 的字段;其余限额留空,保证只有一类会触发。 */
	limits: Record<string, number>;
	expect: LimitKind;
}

/**
 * 轮数与超时两类限制各一次(判据③)。阈值压到必触发。
 *
 * 载荷统一用 L3-001(full_year_audit):它必然需要多轮工具调用,否则 P1 的 maxTurns=1
 * 可能一轮就答完而不触发,探针就变成假阳性。
 *
 */
export const PROBES: readonly ProbeSpec[] = [
	{ id: "P1", caseId: "L3-001", limits: { maxTurns: 1 }, expect: "maxTurns" },
	{ id: "P2", caseId: "L3-001", limits: { runTimeoutMs: 1000 }, expect: "runTimeout" },
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
				? `轮数与超时两类限制各触发一次且归类正确(${outcomes.length}/${PROBES.length})`
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
		"# 判据③ · 轮数与超时两类限制探针",
		"",
		"| 探针 | 期望 limit | 实际 status | 实际 limit | 结果 |",
		"|---|---|---|---|---|",
		rows,
		"",
		`**判据③**:${verdict.pass ? "通过" : "**不通过**"} —— ${verdict.detail}`,
		"",
	].join("\n");
}
