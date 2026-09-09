import type { AuditReportDataset, ReportTask } from "./report-contracts.ts";

export const REGULAR_CHECKS = [
	"岗位设置",
	"不相容职务分离",
	"授权审批",
	"财产保护",
	"预算控制",
	"客户账户管理",
	"适当性管理",
	"员工执业行为管理",
	"客户投诉处理",
	"廉洁从业管理",
	"财务管理",
	"信息系统管理",
] as const;
export const AML_CHECKS = [
	"反洗钱组织机制",
	"反洗钱制度及备案",
	"客户身份识别",
	"客户风险分类",
	"外部监管或执法函件录入",
	"大额及可疑交易甄别与报送",
	"客户身份资料和交易记录保存",
	"反洗钱培训与宣传",
] as const;
export const TURNOVER_CHECKS = [
	...REGULAR_CHECKS,
	"反洗钱履职",
	"重大经营决策执行",
	"重大事故和突发事件",
	"诉讼、投诉及其他未了事项",
	"监管及内部处罚",
	"信访及案件",
] as const;

export function workflowErrors(task: ReportTask): string[] {
	const w = task.workflow;
	if (!w) return ["workflow: 缺少报告生成方式及征求意见匹配结果。"];
	const errors: string[] = [];
	if (task.reportType === "regular") {
		if (!w.matchingCompleted) errors.push("workflow: 尚未查询对应征求意见书。");
		if (w.mode !== "independent" && w.mode !== "linked") errors.push("workflow: 常规报告生成方式无效。");
		if (w.consultationExists !== (w.mode === "linked"))
			errors.push("workflow: 存在征求意见书时必须关联，不存在时应独立生成。");
		if (
			w.mode === "linked" &&
			(!w.sourceReportId || !Number.isInteger(w.sourceVersion) || (w.sourceVersion ?? 0) < 1 || !w.sourceDataVersion)
		)
			errors.push("workflow: 缺少征求意见书及复用数据版本。");
		if (
			w.mode === "linked" &&
			(w.feedbackStatus !== "completed" || w.resolutionStatus !== "completed" || !w.feedbackCompletedAt)
		)
			errors.push("workflow: 征求意见反馈或审计处理尚未完成。");
	} else if (w.mode !== task.reportType) errors.push("workflow: 生成方式与报告类型不一致。");
	if (w.mode !== "linked" && (w.sourceReportId || w.sourceVersion || w.sourceDataVersion || w.consultationExists))
		errors.push("workflow: 非关联报告不得携带征求意见来源版本。");
	if (task.reportType === "consultation" && (!w.feedbackDeadline || !w.feedbackRequirement?.trim()))
		errors.push("workflow: 征求意见书缺少反馈期限或整改计划要求。");
	if (w.feedbackDeadline && w.feedbackDeadline < task.reportDate && task.reportType === "consultation")
		errors.push("workflow: 反馈期限不得早于征求意见书日期。");
	if (task.reportType === "turnover" && !task.feedbackCompleted) errors.push("workflow: 离任负责人反馈尚未完成。");
	if (w.feedbackCompletedAt && w.feedbackCompletedAt.slice(0, 10) > task.reportDate)
		errors.push("workflow: 报告日期早于反馈处理完成日期。");
	return errors;
}

export function businessCheckErrors(dataset: AuditReportDataset): string[] {
	const required = dataset.task.reportType === "turnover" ? TURNOVER_CHECKS : [...REGULAR_CHECKS, ...AML_CHECKS];
	const checks = dataset.checks ?? [];
	const errors: string[] = [];
	for (const code of required) {
		const matches = checks.filter((check) => check.code === code);
		const check = matches[0];
		if (matches.length !== 1 || !check || !["conforming", "exception", "not-applicable"].includes(check.result)) {
			errors.push(`checks: ${code}缺失、重复或未完成检查。`);
			continue;
		}
		if (check.result !== "conforming" && !check.factText?.trim())
			errors.push(`checks: ${code}需说明异常或不适用事实。`);
		for (const count of [check.sampleCount, check.exceptionCount])
			if (count !== undefined && (!Number.isInteger(count) || count < 0))
				errors.push(`checks: ${code}数量必须为非负整数。`);
		if (
			check.exceptionCount !== undefined &&
			(check.sampleCount === undefined || check.exceptionCount > check.sampleCount)
		)
			errors.push(`checks: ${code}异常数不得超过检查数。`);
	}
	if (dataset.task.reportType !== "turnover") {
		const aml = dataset.aml;
		if (
			!aml ||
			![
				aml.suspiciousTransactionCount,
				aml.generalSuspiciousTransactionCount,
				aml.keySuspiciousTransactionCount,
			].every((n) => Number.isInteger(n) && n >= 0) ||
			aml.generalSuspiciousTransactionCount + aml.keySuspiciousTransactionCount !== aml.suspiciousTransactionCount
		)
			errors.push("aml: 可疑交易总数必须等于一般与重点之和，且均为非负整数。");
	}
	return errors;
}
