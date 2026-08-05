import type {
	AmlDomainFact,
	AuditFinding,
	AuditReportDataset,
	AuditReportType,
	DataSourceDefinition,
	DerivedRank,
	OperatingMetric,
	ReadinessItem,
	ReportDraft,
	ReportFactPack,
	ReportParagraph,
	ReportSection,
	ReportSubsection,
	ReportTable,
	SourceCoverageAssessment,
} from "./report-contracts.ts";

const sourceStatusWeight: Readonly<Record<DataSourceDefinition["implementationStatus"], number>> = {
	ready: 1,
	"export-only": 0.7,
	manual: 0.55,
	"interface-pending": 0.25,
};

const requiredCapabilities: Readonly<Record<AuditReportType, readonly string[]>> = {
	regular: [
		"audit-project",
		"audit-period",
		"previous-audit-project",
		"workflow-status",
		"organization-id",
		"organization-name",
		"organization-address",
		"organization-history",
		"employee-snapshot",
		"broker-snapshot",
		"appointment-records",
		"operating-amounts",
		"operating-ranks",
		"ranking-participant-count",
		"metric-aliases",
		"finding-id",
		"finding-detail",
		"finding-category",
		"finding-severity",
		"finding-count-semantics",
		"rectification-status",
		"accountability",
		"complaints",
		"lawsuits",
		"regulatory-events",
		"lease-area",
		"template-version",
		"template-slots",
		"generation-rules",
	],
	turnover: [
		"audit-project",
		"audit-period",
		"workflow-status",
		"organization-id",
		"organization-name",
		"employee-snapshot",
		"appointment-records",
		"document-number",
		"issuer",
		"operating-amounts",
		"operating-ranks",
		"ranking-participant-count",
		"finding-id",
		"finding-detail",
		"finding-severity",
		"rectification-status",
		"accountability",
		"complaints",
		"lawsuits",
		"clean-practice",
		"performance-ratings",
		"template-version",
		"template-slots",
		"generation-rules",
	],
	aml: [
		"audit-project",
		"audit-period",
		"organization-id",
		"organization-name",
		"finding-id",
		"finding-detail",
		"finding-category",
		"aml-domain-coverage",
		"suspicious-transactions",
		"risk-review-overdue",
		"regulatory-letter-entry",
		"training-materials",
		"template-version",
		"template-slots",
		"generation-rules",
	],
};

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

export function normalizeChineseProse(value: string): string {
	return value
		.replace(/,/gu, "，")
		.replace(/:/gu, "：")
		.replace(/;/gu, "；")
		.replace(/\?/gu, "？")
		.replace(/!/gu, "！")
		.replace(/\(/gu, "（")
		.replace(/\)/gu, "）")
		.replace(/经审计[，,]\s*经审计[，,]/gu, "经审计，")
		.replace(/(同志任职期内)，任职期内/gu, "$1，")
		.replace(/[ \t]+([，。；：！？])/gu, "$1")
		.replace(/([，。；：！？])[ \t]+/gu, "$1");
}

export function findAdjacentRepeatedPhrase(value: string, minimumLength = 6, maximumLength = 40): string | undefined {
	const compact = value.replace(/\s+/gu, "");
	const upperBound = Math.min(maximumLength, Math.floor(compact.length / 2));
	for (let length = upperBound; length >= minimumLength; length -= 1) {
		for (let index = 0; index + length * 2 <= compact.length; index += 1) {
			const phrase = compact.slice(index, index + length);
			if (phrase === compact.slice(index + length, index + length * 2)) {
				return phrase;
			}
		}
	}
	return undefined;
}

export interface PreviousAuditFindingMatch {
	previous: AuditFinding;
	current: AuditFinding;
}

export interface PreviousAuditFindingReviewCandidate extends PreviousAuditFindingMatch {
	similarity: number;
}

export interface PreviousAuditComparison {
	previousFindings: readonly AuditFinding[];
	currentFindings: readonly AuditFinding[];
	unrectified: readonly PreviousAuditFindingMatch[];
	needsReview: readonly PreviousAuditFindingReviewCandidate[];
	rectified: readonly AuditFinding[];
	newFindings: readonly AuditFinding[];
}

function normalizeFindingMatchText(value: string): string {
	return value
		.replace(/^(?:个别|部分|少数|若干)/u, "")
		.replace(/[，。；：、（）()《》“”"'‘’\s]/gu, "")
		.trim();
}

function findingsRepresentSameProblem(previous: AuditFinding, current: AuditFinding): boolean {
	if (normalizeFindingMatchText(previous.category) !== normalizeFindingMatchText(current.category)) return false;
	const previousSubcategory = normalizeFindingMatchText(previous.subcategory);
	const currentSubcategory = normalizeFindingMatchText(current.subcategory);
	const previousTitle = normalizeFindingMatchText(previous.title);
	const currentTitle = normalizeFindingMatchText(current.title);
	const structurallyAligned =
		(previousSubcategory.length > 0 && previousSubcategory === currentSubcategory) ||
		(previousTitle.length > 0 && previousTitle === currentTitle);
	return structurallyAligned && findingReviewSimilarity(previous, current) >= 0.75;
}

function bigrams(value: string): Set<string> {
	const normalized = normalizeFindingMatchText(value);
	if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
	return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function textSimilarity(left: string, right: string): number {
	const leftTokens = bigrams(left);
	const rightTokens = bigrams(right);
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
	return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function findingReviewSimilarity(previous: AuditFinding, current: AuditFinding): number {
	if (normalizeFindingMatchText(previous.category) !== normalizeFindingMatchText(current.category)) return 0;
	return (
		textSimilarity(previous.subcategory, current.subcategory) * 0.4 +
		textSimilarity(previous.title, current.title) * 0.3 +
		textSimilarity(previous.policyBasis, current.policyBasis) * 0.2 +
		textSimilarity(previous.factText, current.factText) * 0.1
	);
}

export function comparePreviousAuditFindings(findings: readonly AuditFinding[]): PreviousAuditComparison {
	const previousFindings = findings.filter((finding) => finding.isHistorical);
	const currentFindings = findings.filter((finding) => !finding.isHistorical);
	const usedCurrentFindingIds = new Set<string>();
	const unrectified: PreviousAuditFindingMatch[] = [];
	const needsReview: PreviousAuditFindingReviewCandidate[] = [];
	const rectified: AuditFinding[] = [];
	for (const previous of previousFindings) {
		const current = currentFindings.find(
			(candidate) =>
				!usedCurrentFindingIds.has(candidate.findingId) && findingsRepresentSameProblem(previous, candidate),
		);
		if (!current) {
			const reviewCandidate = currentFindings
				.filter((candidate) => !usedCurrentFindingIds.has(candidate.findingId))
				.map((candidate) => ({
					current: candidate,
					similarity: findingReviewSimilarity(previous, candidate),
				}))
				.filter((candidate) => candidate.similarity >= 0.45)
				.sort((left, right) => right.similarity - left.similarity)[0];
			if (reviewCandidate) {
				usedCurrentFindingIds.add(reviewCandidate.current.findingId);
				needsReview.push({ previous, ...reviewCandidate });
			} else {
				rectified.push(previous);
			}
			continue;
		}
		usedCurrentFindingIds.add(current.findingId);
		unrectified.push({ previous, current });
	}
	return {
		previousFindings,
		currentFindings,
		unrectified,
		needsReview,
		rectified,
		newFindings: currentFindings.filter((finding) => !usedCurrentFindingIds.has(finding.findingId)),
	};
}

function previousAuditNarrative(subjectName: string, comparison: PreviousAuditComparison): ReportParagraph | undefined {
	if (comparison.previousFindings.length === 0) return undefined;
	const previousTitles = comparison.previousFindings.map((finding) => finding.title).join("、");
	const unrectifiedTitles = comparison.unrectified.map(({ previous }) => previous.title).join("、");
	const reviewTitles = comparison.needsReview.map(({ previous }) => previous.title).join("、");
	const comparisonConclusion =
		comparison.unrectified.length === 0 && comparison.needsReview.length === 0
			? "经与本次审计发现的问题逐项比对，上述问题本次均未再发现，认定为已整改。"
			: `${unrectifiedTitles ? `其中“${unrectifiedTitles}”问题在本次审计中仍然存在，未有效整改。` : ""}${
					reviewTitles ? `“${reviewTitles}”与本次问题规则比对未形成确定结论，已转交大模型进行语义一致性判断。` : ""
				}`;
	return paragraph(
		"turnover-historical-findings",
		`${subjectName}同志任职期内，审计中心上一次对其所在营业部开展审计发现的问题主要包括：${previousTitles}等问题。${comparisonConclusion}`,
		unique([
			...comparison.previousFindings.flatMap((finding) => finding.evidenceIds),
			...comparison.unrectified.flatMap(({ current }) => current.evidenceIds),
			...comparison.needsReview.flatMap(({ current }) => current.evidenceIds),
		]),
	);
}

function projectEvidenceIds(dataset: AuditReportDataset): string[] {
	return dataset.evidence
		.filter(
			(item) =>
				item.sourceId === "DS-01" &&
				(item.sourceRecordId === dataset.task.taskId || item.normalizedValue === dataset.task.projectId),
		)
		.map((item) => item.evidenceId);
}

function sourceFieldEvidenceIds(dataset: AuditReportDataset, sourceId: string, sourceField: string): string[] {
	return dataset.evidence
		.filter((item) => item.sourceId === sourceId && item.sourceField === sourceField)
		.map((item) => item.evidenceId);
}

function percentage(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
}

export function assessSourceCoverage(dataset: AuditReportDataset): SourceCoverageAssessment {
	const required = requiredCapabilities[dataset.task.reportType];
	const capabilitySource = new Map<string, DataSourceDefinition>();
	for (const source of dataset.sources) {
		for (const capability of source.providedCapabilities) {
			if (!capabilitySource.has(capability)) capabilitySource.set(capability, source);
		}
	}
	const missingCapabilities = required.filter((capability) => !capabilitySource.has(capability));
	let readinessPoints = 0;
	for (const capability of required) {
		const source = capabilitySource.get(capability);
		if (source) readinessPoints += sourceStatusWeight[source.implementationStatus];
	}
	const pendingSources = unique(
		required
			.map((capability) => capabilitySource.get(capability))
			.filter(
				(source): source is DataSourceDefinition => source !== undefined && source.implementationStatus !== "ready",
			)
			.map((source) => `${source.sourceId} ${source.name}（${source.implementationStatus}）`),
	);
	return {
		reportType: dataset.task.reportType,
		requiredCapabilityCount: required.length,
		coveredCapabilityCount: required.length - missingCapabilities.length,
		designCoverage: percentage(required.length - missingCapabilities.length, required.length),
		productionReadiness: percentage(readinessPoints, required.length),
		missingCapabilities,
		pendingSources,
	};
}

function rankBand(rank: number, participants: number): DerivedRank["band"] {
	const ratio = rank / participants;
	if (ratio <= 0.2) return "上游";
	if (ratio <= 0.4) return "中上游";
	if (ratio <= 0.6) return "中游";
	if (ratio <= 0.8) return "中下游";
	return "下游";
}

function buildDerivedRanks(metrics: readonly OperatingMetric[]): DerivedRank[] {
	const ranks: DerivedRank[] = [];
	for (const metric of metrics) {
		for (const point of metric.points) {
			if (point.rank === undefined || point.participants === undefined) continue;
			ranks.push({
				metricCode: metric.metricCode,
				period: point.period,
				rank: point.rank,
				participants: point.participants,
				band: rankBand(point.rank, point.participants),
			});
		}
	}
	return ranks;
}

function readiness(
	fieldId: string,
	state: ReadinessItem["state"],
	blocking: boolean,
	message: string,
	evidenceIds: readonly string[],
): ReadinessItem {
	return { fieldId, state, blocking, message, evidenceIds };
}

function riskReadiness(dataset: AuditReportDataset): ReadinessItem {
	if (dataset.riskEvents.length === 0) {
		return readiness("common.risk_events", "MISSING", true, "风险事项来源未返回任何状态，不能解释为无事项。", []);
	}
	const missing = dataset.riskEvents.filter((event) => event.state === "MISSING" || event.state === "CONFLICTED");
	if (missing.length > 0) {
		return readiness(
			"common.risk_events",
			missing.some((event) => event.state === "CONFLICTED") ? "CONFLICTED" : "MISSING",
			true,
			"风险事项存在未取得或冲突状态，禁止生成确定性否定结论。",
			unique(missing.flatMap((event) => event.evidenceIds)),
		);
	}
	const hasEvent = dataset.riskEvents.some((event) => event.state === "VERIFIED_VALUE");
	return readiness(
		"common.risk_events",
		hasEvent ? "VERIFIED_VALUE" : "VERIFIED_NONE",
		false,
		hasEvent ? "已取得风险事项并保留无事项核验结果。" : "权威来源已确认无风险事项。",
		unique(dataset.riskEvents.flatMap((event) => event.evidenceIds)),
	);
}

function hasCompleteOrganizationOverview(dataset: AuditReportDataset): boolean {
	return (
		dataset.organization.address.trim().length > 0 &&
		!dataset.organization.address.includes("模拟地址") &&
		dataset.organization.areaSquareMeters > 0 &&
		dataset.personnel.employeeCount > 0
	);
}

function organizationOverviewText(dataset: AuditReportDataset, includeAppointmentSummary: boolean): string {
	if (!hasCompleteOrganizationOverview(dataset)) {
		return `${dataset.organization.fullName}机构概况关键字段尚未完整取得，待从机构主数据及人力系统补充核验后生成。`;
	}
	const staffingText = `截至审计期末，营业部共有正式员工${dataset.personnel.employeeCount}名${
		dataset.personnel.brokerCount > 0 ? `，证券经纪人${dataset.personnel.brokerCount}名` : ""
	}。`;
	const appointmentText = includeAppointmentSummary ? `${appointmentSummary(dataset)}。` : "";
	const constructedOverview = `${dataset.organization.fullName}位于${dataset.organization.address}，营业面积${dataset.organization.areaSquareMeters}平方米。${staffingText}${appointmentText}`;
	const history = dataset.organization.historyStatement?.trim();
	return `${constructedOverview}${history ?? ""}`;
}

export function buildFactPack(dataset: AuditReportDataset): ReportFactPack {
	const organizationMatchesTask = dataset.organization.organizationId === dataset.task.organizationId;
	const organizationOverviewComplete = dataset.task.reportType === "aml" || hasCompleteOrganizationOverview(dataset);
	const items: ReadinessItem[] = [
		readiness(
			"common.organization",
			!organizationMatchesTask ? "CONFLICTED" : organizationOverviewComplete ? "VERIFIED_VALUE" : "MISSING",
			!organizationMatchesTask || !organizationOverviewComplete,
			!organizationMatchesTask
				? "营业部主数据与任务机构不匹配。"
				: organizationOverviewComplete
					? dataset.task.reportType === "aml"
						? "营业部主数据与任务机构匹配；反洗钱报告不使用地址、面积和人员概况字段。"
						: "营业部主数据与任务机构匹配，地址、面积及人员关键字段完整。"
					: "营业部地址、面积或人员数量未从权威来源完整取得，禁止使用模拟地址或零值生成机构概况。",
			unique([...dataset.organization.evidenceIds, ...dataset.personnel.evidenceIds]),
		),
		readiness(
			"common.personnel",
			dataset.personnel.asOf >= dataset.task.auditEnd ? "VERIFIED_VALUE" : "CONFLICTED",
			dataset.personnel.asOf < dataset.task.auditEnd,
			"人员快照应覆盖审计期末。",
			dataset.personnel.evidenceIds,
		),
		readiness(
			"common.operating_metrics",
			dataset.operatingMetrics.length > 0 ? "VERIFIED_VALUE" : "MISSING",
			dataset.task.reportType !== "aml" && dataset.operatingMetrics.length === 0,
			"经营指标用于常规和离任报告。",
			unique(dataset.operatingMetrics.flatMap((metric) => metric.points.flatMap((point) => point.evidenceIds))),
		),
		readiness(
			"common.audit_findings",
			"VERIFIED_VALUE",
			false,
			`问题库已返回${dataset.findings.length}条完整问题详情。`,
			unique(dataset.findings.flatMap((finding) => finding.evidenceIds)),
		),
		riskReadiness(dataset),
	];

	if (dataset.task.reportType === "turnover") {
		const subjectAppointments = dataset.appointments.filter(
			(record) => record.personId === dataset.task.subjectPersonId && record.documentNumber.trim().length > 0,
		);
		const appointmentStart = subjectAppointments
			.map((record) => record.startDate)
			.sort()
			.at(0);
		const appointmentEnd = subjectAppointments
			.filter((record) => record.endDate)
			.map((record) => record.endDate as string)
			.sort()
			.at(-1);
		items.push(
			readiness(
				"turnover.appointments",
				subjectAppointments.length >= 2 ? "VERIFIED_VALUE" : "MISSING",
				subjectAppointments.length < 2,
				"离任报告需取得任职和免职记录。",
				unique(subjectAppointments.flatMap((record) => record.evidenceIds)),
			),
		);
		items.push(
			readiness(
				"turnover.appointment_window",
				appointmentStart && appointmentEnd ? "VERIFIED_VALUE" : "MISSING",
				!appointmentStart || !appointmentEnd,
				"离任报告任职起止期间必须由OA任免发文中的任职、免职记录推导。",
				unique(subjectAppointments.flatMap((record) => record.evidenceIds)),
			),
		);
	}

	if (dataset.task.reportType === "aml") {
		const expectedDomains = new Set<AmlDomainFact["domain"]>([
			"internal-control",
			"customer-identification",
			"risk-classification",
			"large-suspicious-transactions",
			"record-retention",
			"training-publicity",
		]);
		const presentDomains = new Set(dataset.aml?.domains.map((domain) => domain.domain) ?? []);
		const complete = [...expectedDomains].every((domain) => presentDomains.has(domain));
		const unresolved = dataset.aml?.domains.some(
			(domain) => domain.state === "MISSING" || domain.state === "CONFLICTED",
		);
		items.push(
			readiness(
				"aml.domain_coverage",
				complete && !unresolved ? "VERIFIED_VALUE" : "MISSING",
				!complete || unresolved === true,
				"反洗钱六个必查领域必须全部取得状态。",
				unique(dataset.aml?.domains.flatMap((domain) => domain.evidenceIds) ?? []),
			),
		);
		const aml = dataset.aml;
		items.push(
			readiness(
				"aml.problem_query",
				aml?.problemQueryComplete === true ? "VERIFIED_VALUE" : "MISSING",
				aml?.problemQueryComplete !== true,
				"反洗钱问题列表及完整详情查询必须完成；查询不完整不能按零问题处理。",
				unique(
					dataset.findings
						.filter((finding) => finding.category === "反洗钱工作")
						.flatMap((finding) => finding.evidenceIds),
				),
			),
		);
		items.push(
			readiness(
				"aml.major_matter_query",
				aml?.majorMatterQueryComplete === true ? "VERIFIED_VALUE" : "MISSING",
				aml?.majorMatterQueryComplete !== true,
				"重大违法违规、重大内控缺陷、监管处罚和重大风险事项查询必须完成。",
				unique(aml?.majorMatters.flatMap((matter) => matter.evidenceIds) ?? []),
			),
		);
	}

	const coverage = assessSourceCoverage(dataset);
	const blockers = items.filter((item) => item.blocking).map((item) => `${item.fieldId}: ${item.message}`);
	if (!dataset.task.feedbackCompleted) blockers.push("审计征求意见反馈流程未完成。");
	if (dataset.task.reportType === "turnover") {
		const previousAuditComparison = comparePreviousAuditFindings(dataset.findings);
		const narrativeClaimsPreviousAudit = /历次审计发现的问题主要包括|上一次审计发现的问题主要包括/u.test(
			dataset.fixedFacts.historicalFindingSummary,
		);
		if (narrativeClaimsPreviousAudit && previousAuditComparison.previousFindings.length === 0) {
			blockers.push(
				"历史叙述表明存在上一次审计问题，但原始系统未返回上一次审计项目及问题明细，不能使用汇总叙述代替两期问题比对。",
			);
		}
	}
	const warnings: string[] = [];
	if (coverage.missingCapabilities.length > 0) {
		warnings.push(`数据源仍缺少能力：${coverage.missingCapabilities.join("、")}`);
	}
	if (coverage.productionReadiness < 80) {
		warnings.push(`生产数据源接入准备度仅${coverage.productionReadiness}%，模拟数据不能替代接口联调。`);
	}
	const disclosedFindings = (
		dataset.task.reportType === "aml"
			? dataset.findings.filter((finding) => finding.category === "反洗钱工作")
			: dataset.findings.filter((finding) => !finding.isHistorical)
	)
		.slice()
		.sort(
			(left, right) =>
				(left.sourceOrder ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrder ?? Number.MAX_SAFE_INTEGER),
		);
	return {
		task: dataset.task,
		readiness: items,
		blockers,
		warnings,
		derivedRanks: buildDerivedRanks(dataset.operatingMetrics),
		disclosedFindingIds: disclosedFindings.map((finding) => finding.findingId),
		evidenceIds: unique(items.flatMap((item) => item.evidenceIds)),
		sourceDesignCoverage: coverage.designCoverage,
		sourceProductionReadiness: coverage.productionReadiness,
	};
}

function chineseDateRange(start: string, end: string): string {
	const [startYear, startMonth] = start.split("-");
	const [endYear, endMonth] = end.split("-");
	return `${startYear}年${Number(startMonth)}月至${endYear}年${Number(endMonth)}月`;
}

function yearMonth(date: string): string {
	const [year, month] = date.split("-");
	return `${year}年${Number(month)}月`;
}

function chineseFullDate(date: string): string {
	const [year, month, day] = date.split("-");
	return `${year}年${Number(month)}月${Number(day)}日`;
}

function subjectAppointments(dataset: AuditReportDataset) {
	return dataset.appointments
		.filter((record) => record.personId === dataset.task.subjectPersonId)
		.slice()
		.sort((left, right) => left.startDate.localeCompare(right.startDate));
}

function appointmentWindow(dataset: AuditReportDataset): { start?: string; end?: string } {
	const records = subjectAppointments(dataset);
	const start = records.at(0)?.startDate;
	const end = records
		.filter((record) => record.endDate)
		.map((record) => record.endDate as string)
		.sort()
		.at(-1);
	return { start, end };
}

function appointmentSentence(record: AuditReportDataset["appointments"][number]): string {
	const title = (record.fullTitle ?? record.title).replace(/[。；;]+$/u, "").trim();
	if (record.action === "appoint") return `聘任${record.personName}同志为${title}`;
	if (record.action === "acting") return `${record.personName}同志代为履行${title}`;
	if (record.action === "transfer") return `调任${record.personName}同志为${title}`;
	return `免去${record.personName}同志的${title.replace(/职务$/u, "")}`;
}

function subjectRole(dataset: AuditReportDataset): string {
	const activeRecord = subjectAppointments(dataset)
		.filter((record) => !record.endDate)
		.at(-1);
	const title = activeRecord?.title ?? "负责人";
	const role = title
		.replace(/^.*?证券营业部(?:（[^）]+）)?/u, "")
		.replace(/职务$/u, "")
		.trim();
	return role || "负责人";
}

function paragraph(
	paragraphId: string,
	text: string,
	evidenceIds: readonly string[],
	requiresHumanReview = false,
): ReportParagraph {
	return {
		paragraphId,
		text: normalizeChineseProse(text),
		evidenceIds: unique(evidenceIds),
		requiresHumanReview,
	};
}

function collectMetricEvidence(metrics: readonly OperatingMetric[]): string[] {
	return unique(metrics.flatMap((metric) => metric.points.flatMap((point) => point.evidenceIds)));
}

function operatingTables(metrics: readonly OperatingMetric[]): ReportTable[] {
	if (metrics.length === 0) return [];
	const periods = metrics[0]?.points.map((point) => point.period) ?? [];
	const financial = metrics.filter((metric) => metric.table === "financial");
	const performance = metrics.filter((metric) => metric.table === "performance");
	const ranked = metrics.filter(
		(metric) => metric.includeInRanking && metric.points.some((point) => point.rank !== undefined),
	);
	const valueTable = (tableId: string, title: string, selected: readonly OperatingMetric[]): ReportTable => ({
		tableId,
		title,
		unit: selected.every((metric) => metric.unit === "万元") ? "万元" : undefined,
		headers: ["项目", ...periods.map((period) => `${period}完成数`)],
		rows: selected.map((metric) => [
			metric.reportLabel,
			...metric.points.map((point) =>
				point.value.toLocaleString("zh-CN", {
					minimumFractionDigits: 2,
					maximumFractionDigits: 2,
					useGrouping: true,
				}),
			),
		]),
		sourceEvidenceIds: collectMetricEvidence(selected),
	});
	return [
		{
			...valueTable("financial", "表1：财务指标", financial),
			notes: ["备注：代理买卖证券业务净收入扣除经纪人提成"],
		},
		valueTable("performance", "表2：业绩指标", performance),
		{
			tableId: "ranking",
			title: "表3：指标排名情况",
			headers: ["项目", ...periods.map((period) => `${period}排名`)],
			rows: ranked.map((metric) => [
				metric.reportLabel.replace(/（.*?）/gu, ""),
				...metric.points.map((point) => point.rank ?? "—"),
			]),
			sourceEvidenceIds: collectMetricEvidence(ranked),
		},
	];
}

function rankingParticipantNote(metrics: readonly OperatingMetric[]): string {
	const points = metrics.flatMap((metric) => metric.points);
	const periods = unique(points.map((point) => point.period));
	const participants = periods.map(
		(period) => points.find((point) => point.period === period && point.participants !== undefined)?.participants,
	);
	if (periods.length === 0 || participants.some((value) => value === undefined)) {
		return "备注：上述排名剔除已撤销营业部。";
	}
	const firstPeriod = periods[0] ?? "";
	const lastPeriod = periods.at(-1) ?? "";
	const lastDisplay = lastPeriod.replace(/年1[-—]9月/u, "年9月");
	return `备注：上述排名剔除已撤销营业部。${firstPeriod}-${lastDisplay}，参与排名的营业部年度家数分别为${participants.join("、")}。`;
}

function operatingNarrative(dataset: AuditReportDataset, pack: ReportFactPack): string {
	const revenueCodes = [
		"brokerage_net_revenue",
		"deposit_interest_net_revenue",
		"product_revenue",
		"margin_interest_revenue",
		"other_revenue",
	];
	const revenueMetrics = dataset.operatingMetrics.filter((metric) => revenueCodes.includes(metric.metricCode));
	const latestRevenue = revenueMetrics
		.map((metric) => ({ metric, value: metric.points.at(-1)?.value ?? 0 }))
		.sort((a, b) => b.value - a.value)[0];
	const primary = latestRevenue?.metric.reportLabel.replace(/^其中：/u, "") ?? "经纪业务收入";
	const clientAssets = dataset.operatingMetrics.find((metric) => metric.metricCode === "client_assets");
	const stockFund = dataset.operatingMetrics.find((metric) => metric.metricCode === "stock_fund_volume");
	const increasing = (metric: OperatingMetric | undefined): boolean =>
		metric?.points.every((point, index, values) => index === 0 || point.value >= (values[index - 1]?.value ?? 0)) ??
		false;
	const decreasing = (metric: OperatingMetric | undefined): boolean =>
		metric?.points.every((point, index, values) => index === 0 || point.value <= (values[index - 1]?.value ?? 0)) ??
		false;
	const trend = (metric: OperatingMetric | undefined): string => {
		if (increasing(metric)) return "逐年增长";
		if (decreasing(metric)) return "总体下降";
		return "有所波动";
	};
	const bands = unique(pack.derivedRanks.map((rank) => rank.band));
	const bandText =
		bands.includes("中下游") && bands.includes("中游")
			? "中游至中下游"
			: bands.length > 0
				? bands.join("、")
				: "待确认";
	return `审计期内，财务指标方面，营业部以${primary}为主要收入来源。业绩指标方面，客户资产规模${trend(
		clientAssets,
	)}，股基交易量${trend(stockFund)}。从指标排名情况来看，营业部各项指标排名基本处于公司所有营业部${bandText}水平。`;
}

function turnoverOperatingNarrative(dataset: AuditReportDataset, pack: ReportFactPack, subjectName: string): string {
	const netProfit = dataset.operatingMetrics.find((metric) => metric.metricCode === "net_profit");
	const fullYearProfitPoints = netProfit?.points.filter((point) => !point.period.includes("月")) ?? [];
	const profitText =
		fullYearProfitPoints.length > 0 && fullYearProfitPoints.every((point) => point.value > 0)
			? "各已覆盖完整年度均实现盈利，"
			: "";
	const bands = unique(pack.derivedRanks.map((rank) => rank.band));
	const bandText =
		bands.includes("中下游") && bands.includes("中游")
			? "中游至中下游"
			: bands.length > 0
				? bands.join("、")
				: "待确认";
	return `${subjectName}同志任职期内，营业部${profitText}以代理买卖证券业务净收入为主要收入来源。完整年度各项业绩指标总体有所波动，整体排名处于公司所有营业部${bandText}水平。`;
}

function appointmentSummary(dataset: AuditReportDataset): string {
	return dataset.appointments
		.filter((record) => record.action !== "remove")
		.map((record) => {
			if (record.action === "appoint" && record.endDate && record.endDate !== record.startDate) {
				return `${record.personName}同志自${yearMonth(record.startDate)}至${yearMonth(record.endDate)}任${record.title}`;
			}
			if (record.action === "acting") {
				return `${yearMonth(record.startDate)}，${record.personName}同志代为履行${record.title}`;
			}
			return `${yearMonth(record.startDate)}，${appointmentSentence(record)}`;
		})
		.join("；");
}

function riskParagraphs(dataset: AuditReportDataset): ReportParagraph[] {
	const absenceTypes = ["security-incident", "major-emergency", "lawsuit", "complaint"] as const;
	const absenceLabels: Readonly<Record<string, string>> = {
		"security-incident": "重大信息安全事故",
		"major-emergency": "重大突发事件",
		complaint: "未了结客户投诉",
		lawsuit: "未决诉讼",
	};
	const absenceEvents = absenceTypes
		.map((type) => dataset.riskEvents.find((event) => event.type === type && event.state === "VERIFIED_NONE"))
		.filter((event): event is AuditReportDataset["riskEvents"][number] => event !== undefined);
	const paragraphs: ReportParagraph[] = [];
	if (absenceEvents.length > 0) {
		paragraphs.push(
			paragraph(
				"risk-none",
				`经向营业部人员询问和检查相关资料，并向公司其他相关职能部门了解，审计期内，营业部未发生${absenceEvents
					.map((event) => absenceLabels[event.type] ?? event.type)
					.join("、")}等事项。`,
				absenceEvents.flatMap((event) => event.evidenceIds),
				true,
			),
		);
	}
	for (const event of dataset.riskEvents) {
		if (event.state === "VERIFIED_VALUE" && event.description) {
			paragraphs.push(
				paragraph(`risk-${event.eventId}`, event.regularDescription ?? event.description, event.evidenceIds, true),
			);
		}
	}
	return paragraphs;
}

function nonDuplicativeSubitems(finding: AuditFinding): readonly string[] {
	const fact = finding.factText.replace(/[\s，。；：、“”‘’（）()]/gu, "");
	return (finding.internalSubitems ?? []).filter((subitem) => {
		const compact = subitem.replace(/^（\d+）/u, "").replace(/[\s，。；：、“”‘’（）()]/gu, "");
		return compact.length > 0 && !fact.includes(compact);
	});
}

const categoryNumerals = ["（一）", "（二）", "（三）", "（四）", "（五）", "（六）", "（七）", "（八）"];

function findingSubsections(findings: readonly AuditFinding[]): ReportSubsection[] {
	const categories = unique(findings.map((finding) => finding.category));
	return categories.map((category, categoryIndex) => {
		const categoryFindings = findings.filter((finding) => finding.category === category);
		const paragraphs: ReportParagraph[] = [];
		for (const [findingIndex, finding] of categoryFindings.entries()) {
			paragraphs.push(
				paragraph(
					`finding-${finding.findingId}-title`,
					`${findingIndex + 1}.${finding.title}`,
					finding.evidenceIds,
				),
			);
			paragraphs.push(paragraph(`finding-${finding.findingId}-policy`, finding.policyBasis, finding.evidenceIds));
			paragraphs.push(paragraph(`finding-${finding.findingId}-fact`, finding.factText, finding.evidenceIds, true));
			for (const [subitemIndex, subitem] of nonDuplicativeSubitems(finding).entries()) {
				paragraphs.push(
					paragraph(
						`finding-${finding.findingId}-subitem-${subitemIndex + 1}`,
						subitem,
						finding.evidenceIds,
						true,
					),
				);
			}
		}
		return {
			heading: `${categoryNumerals[categoryIndex] ?? `（${categoryIndex + 1}）`}${category}`,
			paragraphs,
		};
	});
}

function amlFindingSubsections(findings: readonly AuditFinding[]): ReportSubsection[] {
	return findings.map((finding, index) => ({
		heading: `${categoryNumerals[index] ?? `（${index + 1}）`}${finding.title}`,
		paragraphs: [
			paragraph(`finding-${finding.findingId}-policy`, finding.policyBasis, finding.evidenceIds),
			paragraph(`finding-${finding.findingId}-fact`, finding.factText, finding.evidenceIds, true),
			...nonDuplicativeSubitems(finding).map((subitem, subitemIndex) =>
				paragraph(`finding-${finding.findingId}-subitem-${subitemIndex + 1}`, subitem, finding.evidenceIds, true),
			),
		],
	}));
}

function amlRiskClassificationNarrative(aml: NonNullable<AuditReportDataset["aml"]>): string {
	const newAccountTotal = aml.newAccountRiskRecords.reduce((sum, record) => sum + record.sampleCount, 0);
	const newAccountExceptions = aml.newAccountRiskRecords.reduce((sum, record) => sum + record.exceptionCount, 0);
	const periodicTotal = aml.periodicReviewRecords.reduce((sum, record) => sum + record.sampleCount, 0);
	const periodicExceptions = aml.periodicReviewRecords.reduce((sum, record) => sum + record.exceptionCount, 0);
	const newAccountSentence =
		newAccountExceptions > 0
			? `营业部基本能够按照公司规定完成新开户客户的风险等级划分工作，但审计期内尚存在${newAccountExceptions}笔划分不及时的情况。`
			: "营业部能够按照公司规定完成新开户客户的风险等级划分工作。";
	const periodicSentence =
		periodicExceptions > 0
			? `营业部基本按规定对不同风险等级客户开展定期审核并记录审核结果，但抽查${periodicTotal}笔高风险客户定期审核记录，发现${periodicExceptions}笔未在规定期限内完成。`
			: "营业部按规定对不同风险等级客户开展定期审核工作，并记录审核结果。";
	return `${newAccountSentence}${periodicSentence}${
		newAccountTotal > 0 ? "" : "新开户客户风险等级划分记录未返回可核验样本。"
	}`;
}

function amlLetterNarrative(aml: NonNullable<AuditReportDataset["aml"]>): string {
	const inScope = aml.regulatoryLetters.filter((letter) => letter.inScope);
	const overdue = inScope.filter((letter) => letter.overdue).length;
	return overdue > 0
		? ""
		: "当收到可能导致客户风险状况发生实质性变化的外部监管机构或执法机关的协查函、警示函时，营业部能够按时在反洗钱管理系统中录入信息。";
}

function amlSuspiciousNarrative(aml: NonNullable<AuditReportDataset["aml"]>): string {
	const total = aml.generalSuspiciousTransactionCount + aml.keySuspiciousTransactionCount;
	const typeText =
		aml.generalSuspiciousTransactionCount === total
			? `共${total}笔，均为一般可疑交易`
			: aml.keySuspiciousTransactionCount === total
				? `共${total}笔，均为重点可疑交易`
				: `共${total}笔，其中${aml.generalSuspiciousTransactionCount}笔为一般可疑交易，${aml.keySuspiciousTransactionCount}笔为重点可疑交易`;
	return `营业部能够按照公司规定完成可疑交易甄别工作，并在反洗钱监控系统内填写批注、保存工作底稿，并通过系统向总部报送。审计期内，营业部上报并经总部认定的可疑交易${typeText}，公司已按照相关要求向反洗钱行政管理部门报送。经检查，营业部对系统筛查出的可疑交易，结合客户身份特征、交易特征等情况开展了人工分析，根据可疑交易监控指标进行综合研判后得出审核结论。同时，营业部已按照公司规定重新评定相关客户风险等级。`;
}

function amlDomainNarrative(domain: AmlDomainFact, aml: NonNullable<AuditReportDataset["aml"]>): string {
	if (domain.domain === "internal-control") {
		return "内控机制建设方面，营业部根据总部反洗钱相关制度，结合营业部实际情况制定了营业部反洗钱内控制度及配套流程。营业部反洗钱制度涵盖了客户身份识别、客户风险等级划分、大额交易和可疑交易报告、客户身份资料和交易记录保存、反恐怖融资和涉恐资产冻结、宣传培训、绩效考核、责任追究等方面的内部操作规程和控制措施。";
	}
	if (domain.domain === "customer-identification") {
		return `客户身份识别方面，在与客户建立业务关系时，营业部遵守账户实名制要求和“了解你的客户”原则，结合投资者适当性管理要求，认真识别并审核客户身份。业务存续期间，营业部持续关注，及时提示客户更新身份证信息资料，做好客户身份持续识别。${amlLetterNarrative(aml)}`;
	}
	if (domain.domain === "risk-classification") {
		return `客户风险分类管理方面，${amlRiskClassificationNarrative(aml)}`;
	}
	if (domain.domain === "large-suspicious-transactions") {
		return `大额及可疑交易分析报告方面，${amlSuspiciousNarrative(aml)}`;
	}
	if (domain.domain === "record-retention") {
		return "客户身份资料和交易记录保存方面，营业部根据安全、准确、完整、保密等原则以及公司档案管理要求，对客户身份资料和交易记录以及其他与反洗钱工作相关的工作资料进行有效保存。";
	}
	if (domain.domain === "training-publicity") {
		return "培训与宣传方面，营业部在营业场所内通过多种方式积极向客户宣传反洗钱知识，每年不定期组织本部门的日常反洗钱培训。培训内容包括反洗钱最新的法律法规、监管案例以及公司下发的反洗钱培训内容，培训后均做好培训资料、签到表、现场照片等资料的留存工作。";
	}
	return domain.summary;
}

function opinionSubsections(categories: readonly string[]): ReportSubsection[] {
	const groups = [
		{
			heading: "完善账户及业务管理工作",
			match: ["账户开立及适当性管理", "业务流程管理"],
			text: "应严格落实公司账户及业务流程管理方面的各项规定，对关键业务流程加强复核与控制，切实做好客户适当性管理工作。",
		},
		{
			heading: "加强反洗钱工作",
			match: ["反洗钱工作"],
			text: "应提升对反洗钱工作的重视程度，加强对反洗钱监管规定和公司反洗钱制度的学习，确保员工熟练掌握反洗钱各项工作要求，切实提升营业部反洗钱工作的合规性和有效性。",
		},
		{
			heading: "提升合规管理水平",
			match: ["合规管理"],
			text: "应牢固树立合规理念，不断强化风险意识，加强法律法规、行业规则以及公司规章制度学习，切实提升履职能力，完善佣金管理等工作，确保各项业务合法合规开展。",
		},
		{
			heading: "规范营业部基础管理",
			match: ["综合管理", "财务管理"],
			text: "应进一步规范营业部综合管理和财务管理等工作，认真落实公司各类通知及制度要求，完善信息公示、安防管理和挂账清理认定等工作，加强营业部日常管理。",
		},
	];
	const selected = groups.filter((group) => group.match.some((category) => categories.includes(category)));
	const matchedCategories = new Set(selected.flatMap((group) => group.match));
	const unmatched = categories
		.filter((category) => !matchedCategories.has(category))
		.map((category) => ({
			heading: `加强${category}`,
			text: `应针对审计发现的${category}问题逐项制定整改措施，明确责任人和完成时限，加强制度学习、过程复核和整改验收，防止同类问题再次发生。`,
		}));
	return [...selected, ...unmatched].map((group, index) => ({
		heading: `${categoryNumerals[index] ?? `（${index + 1}）`}${group.heading}`,
		paragraphs: [paragraph(`opinion-${index + 1}`, group.text, [], true)],
	}));
}

function regularDraft(dataset: AuditReportDataset, pack: ReportFactPack): ReportDraft {
	const findings = dataset.findings.filter((finding) => pack.disclosedFindingIds.includes(finding.findingId));
	const findingCategories = unique(findings.map((finding) => finding.category));
	const periods = dataset.operatingMetrics[0]?.points.map((point) => point.period) ?? [];
	const regularPeriodEnd = (periods.at(-1) ?? "审计期末").replace(/年1[-—]9月/u, "年9月");
	const overviewText = organizationOverviewText(dataset, true);
	const internalControlText = /^经审计[，,]/u.test(dataset.fixedFacts.internalControlSummary)
		? dataset.fixedFacts.internalControlSummary
		: `经审计，${dataset.fixedFacts.internalControlSummary}`;
	const internalControlParagraphs = [
		paragraph(
			"regular-internal-control",
			internalControlText,
			unique([
				...dataset.organization.evidenceIds,
				...sourceFieldEvidenceIds(dataset, "DS-10", "internalControlSummary"),
			]),
		),
		...riskParagraphs(dataset),
	];
	const sections: ReportSection[] = [
		{
			heading: "一、基本情况",
			paragraphs: [],
			tables: [],
			subsections: [
				{
					heading: "（一）概况",
					paragraphs: [
						paragraph("regular-overview", overviewText, [
							...dataset.organization.evidenceIds,
							...dataset.personnel.evidenceIds,
							...dataset.appointments.flatMap((record) => record.evidenceIds),
						]),
					],
				},
				{
					heading: "（二）经营情况",
					tables: operatingTables(dataset.operatingMetrics),
					tablesAfterParagraphCount: 1,
					paragraphs: [
						paragraph(
							"regular-operating-period",
							`营业部${periods[0] ?? "相关期间"}-${regularPeriodEnd}主要经营情况详见下表：`,
							collectMetricEvidence(dataset.operatingMetrics),
						),
						paragraph(
							"regular-ranking-note",
							rankingParticipantNote(dataset.operatingMetrics),
							collectMetricEvidence(dataset.operatingMetrics),
						),
						paragraph(
							"regular-operating-analysis",
							operatingNarrative(dataset, pack),
							collectMetricEvidence(dataset.operatingMetrics),
							true,
						),
					],
				},
				{ heading: "（三）内部控制情况", paragraphs: internalControlParagraphs },
				{
					heading: "（四）营业部负责人经济责任履行情况",
					paragraphs: [
						paragraph(
							"regular-manager-duty",
							dataset.fixedFacts.managerDutySummary,
							unique([
								...dataset.appointments.flatMap((record) => record.evidenceIds),
								...sourceFieldEvidenceIds(dataset, "DS-10", "managerDutySummary"),
							]),
							true,
						),
					],
				},
				{
					heading: "（五）前次审计整改情况",
					paragraphs: [
						paragraph(
							"regular-previous-rectification",
							dataset.fixedFacts.previousRectificationSummary,
							unique([
								...findings.filter((finding) => finding.isRepeat).flatMap((finding) => finding.evidenceIds),
								...sourceFieldEvidenceIds(dataset, "DS-10", "previousRectificationSummary"),
							]),
						),
					],
				},
			],
		},
		{
			heading: "二、审计发现的主要问题",
			paragraphs: [
				paragraph(
					"regular-findings-intro",
					`从本次审计情况看，营业部在${findingCategories.join("、")}等内部控制方面存在一般缺陷，主要包括以下问题：`,
					findings.flatMap((finding) => finding.evidenceIds),
				),
			],
			tables: [],
			subsections: findingSubsections(findings),
		},
		{
			heading: "三、审计意见及整改要求",
			paragraphs: [
				paragraph(
					"regular-opinion-summary",
					`经审计，未发现${dataset.organization.fullName}经营活动及内部控制存在重大违法违规事项或重大内控缺陷。本次审计发现的问题反映出营业部在${findingCategories.join("、")}等方面工作中，相关人员对规章制度的理解不到位，操作流程执行不规范，业务管理上应进一步完善。`,
					findings.flatMap((finding) => finding.evidenceIds),
					true,
				),
				paragraph("regular-opinion-lead", "针对审计发现的问题，现提出以下审计意见及整改要求：", [], false),
			],
			tables: [],
			subsections: opinionSubsections(findingCategories),
			closingParagraphs: [
				paragraph(
					"regular-final-rectification",
					"你单位应认真制定整改计划，明确问题的整改责任人和整改期限，切实采取有效措施落实整改，并能举一反三，杜绝同类问题的反复出现。审计中心将持续跟踪整改情况，并视情况采取后续审计措施。",
					findings.flatMap((finding) => finding.rectification?.evidenceIds ?? []),
					true,
				),
			],
		},
	];
	return {
		taskId: dataset.task.taskId,
		reportType: "regular",
		templateId: dataset.task.templateId,
		templateVersion: dataset.task.templateVersion,
		titleLines: [dataset.organization.fullName, "常规审计报告"],
		addressee: `${dataset.organization.fullName}：`,
		introduction: paragraph(
			"regular-introduction",
			`按照审计工作安排，审计中心于${dataset.task.auditGroupEstablishedMonth}成立审计组，对你单位${chineseDateRange(dataset.task.auditStart, dataset.task.auditEnd)}期间（以下简称“审计期”）经营活动和内部控制的适当性、合法性和有效性等情况进行了审计。审计组依据相关监管规定及公司制度要求，${dataset.fixedFacts.auditProcedures}审计工作结束后，审计中心向你单位发出了《审计征求意见书》，并得到了确认和反馈。现出具报告如下：`,
			unique([...projectEvidenceIds(dataset), ...sourceFieldEvidenceIds(dataset, "DS-10", "auditProcedures")]),
		),
		sections,
		closingOrganization: "东方证券股份有限公司",
		reportDate: dataset.task.reportDate,
		status: pack.blockers.length > 0 ? "needs-input" : "ready-for-review",
		blockers: pack.blockers,
		warnings: pack.warnings,
		allEvidenceIds: unique([
			...pack.evidenceIds,
			...findings.flatMap((finding) => finding.evidenceIds),
			...dataset.evidence.map((item) => item.evidenceId),
		]),
	};
}

function turnoverDraft(dataset: AuditReportDataset, pack: ReportFactPack): ReportDraft {
	const subjectName = dataset.task.subjectPersonName ?? "被审计人员";
	const subjectId = dataset.task.subjectPersonId;
	const appointments = subjectAppointments(dataset);
	const role = subjectRole(dataset);
	const sourcedAppointmentWindow = appointmentWindow(dataset);
	const currentFindings = dataset.findings.filter((finding) => pack.disclosedFindingIds.includes(finding.findingId));
	const previousAuditComparison = comparePreviousAuditFindings(dataset.findings);
	const historicalFindingsParagraph = previousAuditNarrative(subjectName, previousAuditComparison);
	const currentCategories = unique(currentFindings.map((finding) => finding.category));
	const appointmentParagraphs = appointments.map((record, index) =>
		paragraph(
			`turnover-appointment-${index + 1}`,
			`${chineseFullDate(record.documentDate)}，${record.issuer}发布《${record.documentTitle}》（${record.documentNumber}），${appointmentSentence(
				record,
			)}。`,
			record.evidenceIds,
		),
	);
	const accountability = dataset.riskEvents.find(
		(event) => event.type === "accountability" && event.state === "VERIFIED_VALUE",
	);
	const requiresExceptionConclusion = previousAuditComparison.unrectified.length > 0 || currentFindings.length >= 15;
	const conclusionText = `${subjectName}同志任职期内，基本能够按照国家有关法规和公司规章制度的规定开展各项业务，总体上落实了营业部管理责任和合规与风险管理职责，未发现其所在营业部经营活动及内部控制存在重大违法违规事项或重大内控缺陷。${
		requiresExceptionConclusion
			? "但历次审计发现的问题较多，且个别问题未得到有效整改，营业部合规与风险管理水平有待进一步加强。"
			: ""
	}`;
	const sections: ReportSection[] = [
		{
			heading: `一、${subjectName}同志职务任免情况`,
			paragraphs: appointmentParagraphs,
			tables: [],
			subsections: [],
		},
		{
			heading: `二、${subjectName}同志任职期内主要职责及职责履行情况`,
			paragraphs: [
				paragraph(
					"turnover-duty-intro",
					`${subjectName}同志担任${dataset.organization.fullName}负责人期内，主要工作职责包括负责营业部经营管理，提升营业部经营业绩，完成年度KPI考核指标；落实分支机构各项合规管理、风险管理、内部控制、反洗钱等工作，对分支机构的合规运营承担管理责任；在经营管理活动中遵守廉洁从业规定。任职期内主要职责履行情况如下：`,
					appointments.flatMap((record) => record.evidenceIds),
				),
			],
			tables: [],
			subsections: [
				{
					heading: "（一）所在营业部经营情况",
					tables: operatingTables(dataset.operatingMetrics),
					tablesAfterParagraphCount: 1,
					paragraphs: [
						paragraph(
							"turnover-operating-period",
							`${subjectName}同志任职期内，营业部近年主要经营情况详见下表：`,
							collectMetricEvidence(dataset.operatingMetrics),
						),
						paragraph(
							"turnover-operating-analysis",
							turnoverOperatingNarrative(dataset, pack, subjectName),
							collectMetricEvidence(dataset.operatingMetrics),
							true,
						),
					],
				},
				{
					heading: "（二）所在营业部内部控制情况",
					paragraphs: [
						paragraph(
							"turnover-internal-control",
							`${subjectName}同志任职期内，其所在营业部岗位设置符合内部控制基本要求，并在业务运行过程中基本落实了不相容职务分离控制、授权审批控制、财产保护控制、预算控制等内部控制措施。从审计情况结合各相关职能部门提供信息来看，其所在营业部未发现重大异常，未发生重大信息安全事故、重大突发事件、未决诉讼、未了结客户投诉等事项。`,
							unique([
								...dataset.organization.evidenceIds,
								...dataset.riskEvents.flatMap((event) => event.evidenceIds),
								...sourceFieldEvidenceIds(dataset, "DS-10", "internalControlSummary"),
							]),
							true,
						),
						...(accountability?.description
							? [
									paragraph(
										"turnover-accountability",
										accountability.turnoverDescription ?? accountability.description,
										accountability.evidenceIds,
										true,
									),
								]
							: []),
					],
				},
				{
					heading: "（三）遵守廉洁从业规定情况",
					paragraphs: [
						paragraph(
							"turnover-clean-practice",
							`${subjectName}同志任职期内，基本能够贯彻执行国家有关证券市场发展的方针政策，遵守《证券法》《证券公司内部控制指引》《证券经纪业务管理办法》等法律法规以及证券业务规则，执行廉洁从业规定，支持监查员履职，开展廉洁风险防控工作，公司未受理或办理过涉及${subjectName}同志个人的信访及案件，审计组未发现其个人及其所在营业部存在重大违法违规事项。`,
							unique([...sourceFieldEvidenceIds(dataset, "DS-10", "cleanPracticeSummary")]),
							true,
						),
					],
				},
				{
					heading: "（四）绩效考核情况",
					paragraphs: [
						paragraph(
							"turnover-performance",
							`${dataset.performance.at(0)?.year ?? ""}-${dataset.performance.at(-1)?.year ?? ""}年度，公司对${subjectName}同志绩效考核结果分别为${dataset.performance
								.filter((record) => record.personId === subjectId)
								.map((record) => record.rating)
								.join("、")}。`,
							dataset.performance.flatMap((record) => record.evidenceIds),
						),
					],
				},
			],
		},
		{
			heading: "三、审计发现的主要问题",
			paragraphs: [
				...(historicalFindingsParagraph ? [historicalFindingsParagraph] : []),
				paragraph(
					"turnover-current-findings-intro",
					`从本次审计情况看，营业部在${currentCategories.join("、")}等方面存在一般缺陷，主要包括以下问题：`,
					currentFindings.flatMap((finding) => finding.evidenceIds),
				),
			],
			tables: [],
			subsections: findingSubsections(currentFindings),
		},
		{
			heading: "四、审计结论",
			paragraphs: [
				paragraph(
					"turnover-conclusion",
					conclusionText,
					unique([
						...currentFindings.flatMap((finding) => finding.evidenceIds),
						...sourceFieldEvidenceIds(dataset, "DS-10", "internalControlSummary"),
					]),
					true,
				),
			],
			tables: [],
			subsections: [],
		},
	];
	return {
		taskId: dataset.task.taskId,
		reportType: "turnover",
		templateId: dataset.task.templateId,
		templateVersion: dataset.task.templateVersion,
		titleLines: [`${dataset.organization.fullName}${role}`, `${subjectName}同志离任审计报告`],
		introduction: paragraph(
			"turnover-introduction",
			`根据财富管理委员会委托，审计中心于${dataset.task.auditGroupEstablishedMonth}成立审计组，对${dataset.organization.fullName}${role}${subjectName}同志自${chineseDateRange(sourcedAppointmentWindow.start ?? dataset.task.auditStart, sourcedAppointmentWindow.end ?? dataset.task.auditEnd)}期间（以下简称“任职期”）的履职情况进行了审计。审计组依据相关监管规定及公司制度要求，${dataset.fixedFacts.auditProcedures}审计工作结束后，审计中心向${subjectName}同志发出了离任审计报告征求意见稿，并收到其对征求意见稿的确认和反馈。现出具报告如下：`,
			unique([
				...projectEvidenceIds(dataset),
				...appointments.flatMap((record) => record.evidenceIds),
				...sourceFieldEvidenceIds(dataset, "DS-10", "auditProcedures"),
			]),
		),
		sections,
		closingOrganization: "东方证券股份有限公司",
		reportDate: dataset.task.reportDate,
		status: pack.blockers.length > 0 ? "needs-input" : "ready-for-review",
		blockers: pack.blockers,
		warnings: pack.warnings,
		allEvidenceIds: unique(dataset.evidence.map((item) => item.evidenceId)),
	};
}

function amlDraft(dataset: AuditReportDataset, pack: ReportFactPack): ReportDraft {
	const aml = dataset.aml;
	const findings = dataset.findings.filter((finding) => pack.disclosedFindingIds.includes(finding.findingId));
	const queryComplete = aml?.problemQueryComplete === true && aml?.majorMatterQueryComplete === true;
	const majorMatters = aml?.majorMatters.filter((matter) => matter.confirmedMajor) ?? [];
	const hasMajorMatter = majorMatters.length > 0 || findings.some((finding) => finding.majorConfirmed === true);
	const hasProblems = findings.length > 0;
	const domainParagraphs =
		aml?.domains.map((domain) =>
			paragraph(
				`aml-domain-${domain.domain}`,
				amlDomainNarrative(domain, aml),
				unique([
					...domain.evidenceIds,
					...(domain.domain === "large-suspicious-transactions" ? aml.evidenceIds : []),
					...(domain.domain === "risk-classification"
						? [
								...aml.newAccountRiskRecords.flatMap((record) => record.evidenceIds),
								...aml.periodicReviewRecords.flatMap((record) => record.evidenceIds),
							]
						: []),
					...(domain.domain === "customer-identification"
						? aml.regulatoryLetters.flatMap((record) => record.evidenceIds)
						: []),
				]),
				domain.domain === "risk-classification",
			),
		) ?? [];
	const sections: ReportSection[] = [
		{
			heading: "一、基本情况",
			paragraphs: [
				paragraph(
					"aml-overview",
					"审计期内，营业部按照监管要求及公司制度规定，成立了反洗钱工作小组，制订了营业部反洗钱工作制度，建立了反洗钱日常工作机制，开展了反洗钱工作。",
					domainParagraphs.flatMap((item) => item.evidenceIds),
				),
				...domainParagraphs,
			],
			tables: [],
			subsections: [],
		},
	];
	if (hasProblems) {
		sections.push({
			heading: "二、审计发现的主要问题",
			paragraphs: [
				paragraph(
					"aml-findings-intro",
					"审计期内，未发现营业部在反洗钱工作方面存在重大或重要的内控缺陷，但是仍存在以下不足：",
					findings.flatMap((finding) => finding.evidenceIds),
					true,
				),
			],
			tables: [],
			subsections: amlFindingSubsections(findings),
		});
	}
	const opinionSummary = !queryComplete
		? `因反洗钱问题或重大事项查询尚未完整返回，暂不能对${dataset.organization.fullName}反洗钱工作是否存在重大违法违规事项或重大内控缺陷作出确定性否定结论。`
		: hasMajorMatter
			? `经审计，${dataset.organization.fullName}存在已确认的${majorMatters.map((matter) => matter.matterType).join("、")}，主要涉及${majorMatters.map((matter) => matter.subject).join("、")}。${majorMatters.map((matter) => `${matter.fact}${matter.impact ? `，影响为${matter.impact}` : ""}`).join("；")}该结论依据已确认的重大事项记录形成，待人工复核。`
			: hasProblems
				? `经审计，未发现${dataset.organization.fullName}反洗钱工作存在重大违法违规事项或重大内控缺陷，但仍然发现存在部分问题。`
				: `审计期内，未发现${dataset.organization.fullName}在反洗钱工作方面存在重大违法违规事项或重大内控缺陷。建议在以后的工作中，继续重视反洗钱工作，加强对反洗钱监管规定和公司反洗钱制度的学习，确保员工熟练掌握反洗钱各项工作要求，不断提升营业部反洗钱工作的合规性和有效性。`;
	sections.push({
		heading: hasProblems ? "三、审计意见及整改要求" : "二、审计意见",
		paragraphs: [
			paragraph(
				"aml-opinion-summary",
				opinionSummary,
				unique([
					...findings.flatMap((finding) => finding.evidenceIds),
					...(aml?.majorMatters.flatMap((matter) => matter.evidenceIds) ?? []),
				]),
				true,
			),
			...(hasProblems || hasMajorMatter || !queryComplete
				? [paragraph("aml-opinion-lead", "针对审计发现的问题，现提出以下审计意见及整改要求：", [])]
				: []),
		],
		tables: [],
		subsections:
			hasProblems || hasMajorMatter || !queryComplete
				? [
						{
							heading:
								"（一）应加强对反洗钱监管规定和公司反洗钱制度的学习，确保员工熟练掌握反洗钱各项工作要求。",
							paragraphs: [],
						},
						{
							heading: "（二）应勤勉尽责、主动管理，切实提升营业部反洗钱工作的合规性和有效性。",
							paragraphs: [],
						},
					]
				: [],
		closingParagraphs:
			hasProblems || hasMajorMatter || !queryComplete
				? [
						paragraph(
							"aml-final-rectification",
							"你单位应认真制定整改计划，明确问题的整改责任人和整改期限，切实采取有效措施落实整改，并能举一反三，杜绝同类问题的反复出现。审计中心将持续跟踪整改情况，并视情况采取后续审计措施。",
							findings.flatMap((finding) => finding.rectification?.evidenceIds ?? []),
							true,
						),
					]
				: [],
	});
	return {
		taskId: dataset.task.taskId,
		reportType: "aml",
		templateId: dataset.task.templateId,
		templateVersion: dataset.task.templateVersion,
		titleLines: [dataset.organization.fullName, "反洗钱审计报告"],
		addressee: `${dataset.organization.fullName}：`,
		introduction: paragraph(
			"aml-introduction",
			`按照审计工作安排，审计中心于${dataset.task.auditGroupEstablishedMonth}成立审计组，对你单位${chineseDateRange(dataset.task.auditStart, dataset.task.auditEnd)}期间（以下简称“审计期”）反洗钱工作情况进行了审计，${dataset.fixedFacts.auditProcedures}检查内容包括内控机制建设、客户身份识别、客户风险分类管理、大额交易和可疑交易报告、客户身份资料和交易记录保存、培训与宣传等情况。现出具报告如下：`,
			unique([...projectEvidenceIds(dataset), ...sourceFieldEvidenceIds(dataset, "DS-10", "auditProcedures")]),
		),
		sections,
		closingOrganization: "东方证券股份有限公司",
		reportDate: dataset.task.reportDate,
		status: pack.blockers.length > 0 ? "needs-input" : "ready-for-review",
		blockers: pack.blockers,
		warnings: pack.warnings,
		allEvidenceIds: unique(dataset.evidence.map((item) => item.evidenceId)),
	};
}

export function generateReportDraft(dataset: AuditReportDataset, pack = buildFactPack(dataset)): ReportDraft {
	if (dataset.task.reportType === "regular") return regularDraft(dataset, pack);
	if (dataset.task.reportType === "turnover") return turnoverDraft(dataset, pack);
	return amlDraft(dataset, pack);
}

function markdownTable(table: ReportTable): string {
	const header = `| ${table.headers.join(" | ")} |`;
	const divider = `| ${table.headers.map(() => "---").join(" | ")} |`;
	const rows = table.rows.map((row) => `| ${row.map((value) => String(value)).join(" | ")} |`);
	return [
		`**${table.title}${table.unit ? `　单位：${table.unit}` : ""}**`,
		"",
		header,
		divider,
		...rows,
		...(table.notes ?? []),
	].join("\n");
}

export function renderReportMarkdown(draft: ReportDraft): string {
	const lines: string[] = [];
	for (const title of draft.titleLines) lines.push(`# ${title}`, "");
	if (draft.addressee) lines.push(draft.addressee, "");
	lines.push(draft.introduction.text, "");
	for (const section of draft.sections) {
		lines.push(`## ${section.heading}`, "");
		for (const item of section.paragraphs) lines.push(item.text, "");
		for (const table of section.tables) lines.push(markdownTable(table), "");
		for (const subsection of section.subsections) {
			lines.push(`### ${subsection.heading}`, "");
			const tableIndex = subsection.tablesAfterParagraphCount ?? subsection.paragraphs.length;
			for (const [index, item] of subsection.paragraphs.entries()) {
				if (index === tableIndex) {
					for (const table of subsection.tables ?? []) lines.push(markdownTable(table), "");
				}
				lines.push(item.text, "");
			}
			if (tableIndex >= subsection.paragraphs.length) {
				for (const table of subsection.tables ?? []) lines.push(markdownTable(table), "");
			}
		}
		for (const item of section.closingParagraphs ?? []) lines.push(item.text, "");
	}
	lines.push("", `<div align="right">${draft.closingOrganization}</div>`, "");
	lines.push(`<div align="right">${draft.reportDate}</div>`, "");
	if (draft.status === "needs-input") {
		lines.push("<!-- BLOCKED: 本报告存在未完成的数据准备项，不得作为正式报告。 -->", "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
