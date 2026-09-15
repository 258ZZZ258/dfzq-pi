import type { AuditReportDataset, BusinessCheck } from "./report-contracts.ts";
import { REGULAR_CHECKS } from "./report-workflow.ts";

export interface ControlSummary {
	text: string;
	evidenceIds: readonly string[];
	errors: readonly string[];
}

/** Recompute from checks, never from an upstream report conclusion or DS-10 template prose. */
export function buildControlSummary(dataset: Pick<AuditReportDataset, "checks" | "evidence">): ControlSummary {
	const errors: string[] = [];
	const rows: BusinessCheck[] = [];
	const evidenceIds = new Set<string>();
	const recordIds = new Set<string>();
	for (const code of REGULAR_CHECKS) {
		const matches = (dataset.checks ?? []).filter((row) => row.code === code);
		const row = matches[0];
		if (matches.length !== 1 || !row || !["conforming", "exception", "not-applicable"].includes(row.result)) {
			errors.push(`control-summary: ${code}缺失、重复或未完成检查。`);
			continue;
		}
		const requiredFields = row.result === "conforming" ? ["result"] : ["result", "factText"];
		const proofs = dataset.evidence.filter((proof) => row.evidenceIds.includes(proof.evidenceId));
		const selected = requiredFields.flatMap((field) => {
			const value = field === "result" ? row.result : row.factText;
			const matched = proofs.filter((proof) => proof.sourceId === "DS-03" && proof.sourceField === field);
			return matched.length === 1 && value?.trim() && matched[0]?.normalizedValue === value ? matched : [];
		});
		if (
			selected.length !== requiredFields.length ||
			selected.some((proof) => !proof.sourceRecordId || !proof.dataVersion) ||
			selected.some((proof) => recordIds.has(proof.sourceRecordId)) ||
			new Set(selected.map((proof) => proof.sourceRecordId)).size !== 1 ||
			new Set(selected.map((proof) => proof.dataVersion)).size !== 1
		) {
			errors.push(`control-summary: ${code}缺少同一原始记录及版本的结果或说明依据。`);
			continue;
		}
		rows.push(row);
		for (const proof of selected) {
			evidenceIds.add(proof.evidenceId);
			recordIds.add(proof.sourceRecordId);
		}
	}
	const count = (state: BusinessCheck["result"]) => rows.filter((row) => row.result === state).length;
	const basicControlsConform = ["岗位设置", "不相容职务分离", "授权审批", "财产保护", "预算控制"].every((code) =>
		rows.some((row) => row.code === code && row.result === "conforming"),
	);
	const details = rows
		.filter((row) => row.result !== "conforming")
		.map((row) => {
			const text =
				basicControlsConform && row.result === "exception"
					? (row.factText?.trim() ?? "")
					: `${row.code}：${row.result === "exception" ? "存在异常" : "不适用"}，${row.factText?.trim()}`;
			return /[。！？]$/u.test(text) ? text : `${text}。`;
		})
		.join("");
	return {
		text: errors.length
			? ""
			: basicControlsConform
				? `经审计，营业部岗位设置符合内部控制基本要求，并在业务运行过程中基本落实了不相容职务分离控制、授权审批控制、财产保护控制、预算控制等内部控制措施。${details}`
				: `内部控制检查共涉及${rows.length}项，其中${count("conforming")}项符合要求、${count("exception")}项存在异常、${count("not-applicable")}项不适用。${details}`,
		evidenceIds: errors.length ? [] : [...evidenceIds],
		errors,
	};
}
