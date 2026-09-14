import type {
	BuildSupervisionAnalysisResultInput,
	SupervisionAnalysisResult,
	SupervisionReadiness,
} from "./contracts.ts";
import { selectLatestLitigation } from "./litigation.ts";
import { findSupervisionExtractionRule, SUPERVISION_EXTRACTION_RULE_VERSION } from "./rules.ts";
import { buildSupervisionStatistics } from "./statistics.ts";
import { parseSupervisionTask } from "./task.ts";

const reportOutline = [
	"一、摘要",
	"二、外部事项：（一）监管检查、函件等指出问题及整改情况",
	"二、外部事项：（二）外部审计、检查、调查等指出问题及整改情况",
	"三、内部事项：（一）内部审计、合规、风险检查发现问题及整改情况",
	"三、内部事项：（二）问责处理情况（合规问责、违规经营投资责任追究）",
	"三、内部事项：（三）日常监督情况（合规、风险、法律诉讼案件）",
	"附件",
];

function hasFieldValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	return value !== undefined && value !== null;
}

function assessReadiness(input: BuildSupervisionAnalysisResultInput): SupervisionReadiness {
	const blockers: string[] = [];
	const warnings: string[] = [];
	if (input.task.taskId !== input.snapshot.taskId) blockers.push("taskId与资料快照不一致");
	if (input.snapshot.included.length === 0) blockers.push("没有可分析的已入库资料");
	const missingEvidence = input.issues
		.filter((issue) => issue.confirmationStatus !== "PENDING_REVIEW" && issue.evidenceIds.length === 0)
		.map((issue) => issue.issueId);
	if (missingEvidence.length > 0) blockers.push(`已确认问题缺少证据:${missingEvidence.join(",")}`);
	for (const issue of input.issues.filter((item) => item.confirmationStatus !== "PENDING_REVIEW")) {
		const rule = findSupervisionExtractionRule(issue.extractionRuleId);
		if (!rule) {
			blockers.push(`已确认问题引用未知提取规则:${issue.issueId}:${issue.extractionRuleId}`);
			continue;
		}
		if (rule.reportSection !== issue.reportSection) {
			blockers.push(`已确认问题报告模块与提取规则不一致:${issue.issueId}`);
		}
		const missingFields = rule.extractFields
			.filter((item) => item.required && !hasFieldValue(issue.fieldValues[item.key]))
			.map((item) => item.label);
		if (missingFields.length > 0) {
			warnings.push(`问题${issue.issueId}缺少重点提取字段:${missingFields.join("、")}`);
		}
	}
	const pendingIssues = input.issues.filter((issue) => issue.confirmationStatus === "PENDING_REVIEW").length;
	const pendingRecords = [...input.rectifications, ...input.accountabilities].filter(
		(r) => r.confirmationStatus === "PENDING_REVIEW",
	).length;
	if (pendingRecords) warnings.push(`存在${pendingRecords}条整改或问责记录证据校验未通过，不纳入确认统计`);
	const linkedRectificationIds = new Set(
		input.relations
			.filter(
				(r) =>
					r.relationType === "RECTIFICATION" && (r.status === "AUTO_CONFIRMED" || r.status === "HUMAN_CONFIRMED"),
			)
			.map((r) => r.selectedRecordId),
	);
	const unlinkedRecords = input.rectifications.filter((r) => !linkedRectificationIds.has(r.recordId)).length;
	if (unlinkedRecords) warnings.push(`存在${unlinkedRecords}条整改记录尚未确认对应问题，保留原记录，不计为新增问题`);
	if (pendingIssues > 0) warnings.push(`存在${pendingIssues}项问题待确认`);
	const pendingRelations = input.relations.filter(
		(relation) => relation.status !== "AUTO_CONFIRMED" && relation.status !== "HUMAN_CONFIRMED",
	).length;
	if (pendingRelations > 0) warnings.push(`存在${pendingRelations}项关联关系待处理`);
	const qualityExclusions = input.snapshot.excluded.filter((item) =>
		["processing", "failed", "needs-metadata", "disabled", "MISSING_FILE_DATE", "INVALID_FILE_DATE"].includes(
			item.reason,
		),
	);
	if (qualityExclusions.length > 0)
		warnings.push(`有${qualityExclusions.length}份资料因处理或元数据问题未进入本次快照`);
	const syntheticMaterialTotal = input.snapshot.included.filter((item) => item.dataOrigin === "synthetic").length;
	const syntheticIssueTotal = input.issues.filter((item) => item.dataOrigin === "synthetic").length;
	const syntheticRecordTotal = [...input.rectifications, ...input.accountabilities].filter(
		(item) => item.dataOrigin === "synthetic",
	).length;
	if (syntheticMaterialTotal + syntheticIssueTotal + syntheticRecordTotal > 0) {
		warnings.push(
			`结果包含模拟数据:资料${syntheticMaterialTotal}份、问题${syntheticIssueTotal}项、整改问责记录${syntheticRecordTotal}条`,
		);
	}
	return {
		status: blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "READY_WITH_WARNINGS" : "READY",
		blockers,
		warnings,
	};
}

export function buildSupervisionAnalysisResult(input: BuildSupervisionAnalysisResultInput): SupervisionAnalysisResult {
	const issues = selectLatestLitigation(input.issues, input.task);
	const issueIds = new Set(issues.map((issue) => issue.issueId));
	input = { ...input, issues, relations: input.relations.filter((relation) => issueIds.has(relation.issueId)) };
	return {
		schemaVersion: "supervision-analysis.v1",
		extractionRuleVersion: SUPERVISION_EXTRACTION_RULE_VERSION,
		task: parseSupervisionTask(input.task),
		snapshot: input.snapshot,
		issues: input.issues,
		rectifications: input.rectifications,
		accountabilities: input.accountabilities,
		relations: input.relations,
		statistics: buildSupervisionStatistics(input),
		readiness: assessReadiness(input),
		reportOutline,
	};
}
