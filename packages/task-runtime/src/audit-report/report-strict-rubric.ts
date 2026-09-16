import type {
	AuditReportDataset,
	EvidenceRecord,
	OperatingMetric,
	ReportClaimVerification,
	ReportDraft,
	ReportSentenceVerification,
	StrictClaimScore,
} from "./report-contracts.ts";
import { verifyHistoricalJudgment } from "./report-history-review.ts";
import { reportFieldEvidence, taskDateEvidence } from "./report-task-evidence.ts";
import { REGULAR_CHECKS } from "./report-workflow.ts";

interface SentenceInput {
	location: string;
	text: string;
	evidenceIds: readonly string[];
	cell?: { tableId: string; label: string; header: string; value: string };
}

interface ClaimCandidate {
	key: string;
	claimType: Exclude<ReportClaimVerification["claimType"], "unsupported-factual-statement">;
	claimText: string;
	expectedValue: string;
	expectedNumber?: number;
	variants: readonly string[];
	evidenceIds: readonly string[];
	requireRawValueMatch: boolean;
}

const factualSignal =
	/(\d|截至|审计期|任职|聘任|免去|发布|位于|面积|员工|经纪人|收入|资产|交易量|排名|上游|中游|下游|增长|下降|波动|问题|缺陷|整改|考核|可疑交易|超期|投诉|诉讼|问责|监管|事故|文号|制度|条款|未发生|不存在)/u;

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function normalize(value: string): string {
	return value.replace(/[\s,，。；：、“”‘’（）()《》【】[\]\-—]/gu, "").toLowerCase();
}

function chineseYearMonth(value: string): string {
	const [year, month] = value.split("-");
	return `${year}年${Number(month)}月`;
}

function chineseFullDate(value: string): string {
	const [year, month, day] = value.split("-");
	return `${year}年${Number(month)}月${Number(day)}日`;
}

function chineseDateRange(start: string, end: string): string {
	return `${chineseYearMonth(start)}至${chineseYearMonth(end)}`;
}

function splitSentences(text: string): string[] {
	return (text.match(/[^。！？；]+[。！？；]?/gu) ?? [text]).map((item) => item.trim()).filter(Boolean);
}

function splitClauses(text: string): string[] {
	return (text.match(/[^，；：]+[，；：]?/gu) ?? [text]).map((item) => item.trim()).filter(Boolean);
}

function paragraphInputs(draft: ReportDraft): SentenceInput[] {
	const inputs: SentenceInput[] = [];
	const pushText = (location: string, text: string, evidenceIds: readonly string[], cell?: SentenceInput["cell"]) => {
		for (const [index, sentence] of splitSentences(text).entries()) {
			inputs.push({
				location: `${location}.sentence[${index + 1}]`,
				text: sentence,
				evidenceIds,
				cell,
			});
		}
	};
	for (const [index, line] of draft.titleLines.entries()) {
		pushText(`title[${index + 1}]`, line, []);
	}
	if (draft.addressee) pushText("addressee", draft.addressee, []);
	pushText("introduction", draft.introduction.text, draft.introduction.evidenceIds);
	for (const [sectionIndex, section] of draft.sections.entries()) {
		const sectionLocation = `section[${sectionIndex + 1}]`;
		pushText(`${sectionLocation}.heading`, section.heading, []);
		for (const paragraph of section.paragraphs) {
			pushText(`${sectionLocation}.paragraph[${paragraph.paragraphId}]`, paragraph.text, paragraph.evidenceIds);
		}
		for (const table of section.tables) {
			for (const [rowIndex, row] of table.rows.entries()) {
				for (let columnIndex = 1; columnIndex < row.length; columnIndex += 1) {
					const header = table.headers[columnIndex] ?? `第${columnIndex + 1}列`;
					pushText(
						`${sectionLocation}.table[${table.tableId}].row[${rowIndex + 1}].cell[${columnIndex + 1}]`,
						`${String(row[0])} ${header} ${String(row[columnIndex])}`,
						table.sourceEvidenceIds,
						{ tableId: table.tableId, label: String(row[0]), header, value: String(row[columnIndex]) },
					);
				}
			}
		}
		for (const [subsectionIndex, subsection] of section.subsections.entries()) {
			const subsectionLocation = `${sectionLocation}.subsection[${subsectionIndex + 1}]`;
			pushText(`${subsectionLocation}.heading`, subsection.heading, []);
			for (const paragraph of subsection.paragraphs) {
				pushText(
					`${subsectionLocation}.paragraph[${paragraph.paragraphId}]`,
					paragraph.text,
					paragraph.evidenceIds,
				);
			}
			for (const table of subsection.tables ?? []) {
				for (const [rowIndex, row] of table.rows.entries()) {
					for (let columnIndex = 1; columnIndex < row.length; columnIndex += 1) {
						const header = table.headers[columnIndex] ?? `第${columnIndex + 1}列`;
						pushText(
							`${subsectionLocation}.table[${table.tableId}].row[${rowIndex + 1}].cell[${columnIndex + 1}]`,
							`${String(row[0])} ${header} ${String(row[columnIndex])}`,
							table.sourceEvidenceIds,
							{ tableId: table.tableId, label: String(row[0]), header, value: String(row[columnIndex]) },
						);
					}
				}
			}
		}
		for (const paragraph of section.closingParagraphs ?? []) {
			pushText(
				`${sectionLocation}.closingParagraph[${paragraph.paragraphId}]`,
				paragraph.text,
				paragraph.evidenceIds,
			);
		}
	}
	pushText("closingOrganization", draft.closingOrganization, []);
	pushText("reportDate", draft.reportDate, []);
	return inputs;
}

function metricTrend(metric: OperatingMetric | undefined): string {
	if (!metric) return "";
	const annual = metric.points
		.filter((p) => /^\d{4}年?$/.test(p.period))
		.slice()
		.sort((a, b) => parseInt(a.period, 10) - parseInt(b.period, 10));
	if (
		annual.length < 2 ||
		annual.some((p, i) => i > 0 && parseInt(p.period, 10) !== parseInt(annual[i - 1]!.period, 10) + 1)
	)
		return "";
	let up = 0,
		down = 0;
	for (let i = 1; i < annual.length; i++) {
		if (annual[i]!.value > annual[i - 1]!.value) up++;
		if (annual[i]!.value < annual[i - 1]!.value) down++;
	}
	const trend =
		up === annual.length - 1
			? "逐年增长"
			: down === annual.length - 1
				? "逐年下降"
				: up === 0 && down === 0
					? "保持不变"
					: "有所波动";
	return `${annual[0]!.period.slice(0, 4)}年至${annual.at(-1)!.period.slice(0, 4)}年${metric.reportLabel.replace(/（.*?）/gu, "")}${trend}`;
}

function evidenceForField(dataset: AuditReportDataset, sourceId: string, recordId: string, field: string): string[] {
	return dataset.evidence
		.filter((item) => item.sourceId === sourceId && item.sourceRecordId === recordId && item.sourceField === field)
		.map((item) => item.evidenceId);
}

function referencedFieldEvidence(dataset: AuditReportDataset, references: readonly string[], field: string): string[] {
	const allowed = new Set(references);
	return dataset.evidence
		.filter((item) => allowed.has(item.evidenceId) && item.sourceField === field)
		.map((item) => item.evidenceId);
}

function claimCandidates(dataset: AuditReportDataset): ClaimCandidate[] {
	const candidates: ClaimCandidate[] = [];
	const add = (
		key: string,
		claimType: ClaimCandidate["claimType"],
		claimText: string,
		expectedValue: string | number | boolean,
		variants: readonly string[],
		evidenceIds: readonly string[],
		requireRawValueMatch = claimType === "source-field" || claimType === "source-narrative",
	) => {
		candidates.push({
			key,
			claimType,
			claimText,
			expectedValue: String(expectedValue),
			expectedNumber: typeof expectedValue === "number" ? expectedValue : undefined,
			variants: unique([
				...variants,
				...(key.startsWith("metric.") ? [] : variants.flatMap((variant) => splitSentences(variant))),
				...(key.startsWith("metric.")
					? []
					: variants.flatMap((variant) => splitSentences(variant).flatMap((sentence) => splitClauses(sentence)))),
			]),
			evidenceIds: unique(evidenceIds),
			requireRawValueMatch,
		});
	};

	const taskRecordId = dataset.task.taskId;
	const auditStartEvidence = taskDateEvidence(dataset, "auditStart");
	const auditEndEvidence = taskDateEvidence(dataset, "auditEnd");
	add(
		"task.audit-period",
		"derived-calculation",
		"审计期间",
		`${dataset.task.auditStart}..${dataset.task.auditEnd}`,
		[chineseDateRange(dataset.task.auditStart, dataset.task.auditEnd)],
		auditStartEvidence.length > 0 && auditEndEvidence.length > 0 ? [...auditStartEvidence, ...auditEndEvidence] : [],
		false,
	);
	add(
		"task.audit-group-month",
		"source-field",
		"审计组成立月份",
		dataset.task.auditGroupEstablishedMonth,
		[dataset.task.auditGroupEstablishedMonth],
		taskDateEvidence(dataset, "auditGroupEstablishedMonth"),
	);
	add(
		"task.report-date",
		"source-field",
		"报告日期",
		dataset.task.reportDate,
		[dataset.task.reportDate, chineseFullDate(dataset.task.reportDate)],
		taskDateEvidence(dataset, "reportDate"),
	);
	if (dataset.task.workflow?.feedbackDeadline)
		add(
			"task.feedback-deadline",
			"source-field",
			"反馈期限",
			dataset.task.workflow.feedbackDeadline,
			[chineseFullDate(dataset.task.workflow.feedbackDeadline)],
			[
				...evidenceForField(dataset, "DS-01", taskRecordId, "feedbackDeadline"),
				...reportFieldEvidence(dataset, "feedbackDeadline", dataset.task.workflow.feedbackDeadline),
			],
		);
	if (dataset.task.workflow?.feedbackRequirement)
		add(
			"task.feedback-requirement",
			"source-narrative",
			"本轮反馈及整改要求",
			dataset.task.workflow.feedbackRequirement,
			[dataset.task.workflow.feedbackRequirement],
			reportFieldEvidence(dataset, "feedbackRequirement", dataset.task.workflow.feedbackRequirement),
		);

	const organization = dataset.organization;
	for (const [field, label, value, variants] of [
		["fullName", "营业部全称", organization.fullName, [organization.fullName]],
		["address", "营业地址", organization.address, [organization.address]],
		[
			"areaSquareMeters",
			"营业面积",
			organization.areaSquareMeters,
			[`${organization.areaSquareMeters}平方米`, String(organization.areaSquareMeters)],
		],
		["historyStatement", "机构历史沿革", organization.historyStatement ?? "", [organization.historyStatement ?? ""]],
	] as const) {
		if (String(value) === "") continue;
		add(
			`organization.${field}`,
			field === "historyStatement" ? "source-narrative" : "source-field",
			label,
			value,
			variants,
			referencedFieldEvidence(dataset, organization.evidenceIds, field),
		);
	}

	add(
		"personnel.employeeCount",
		"source-field",
		"正式员工人数",
		dataset.personnel.employeeCount,
		[`正式员工${dataset.personnel.employeeCount}名`],
		referencedFieldEvidence(dataset, dataset.personnel.evidenceIds, "employeeCount"),
	);
	if (dataset.personnel.brokerCount !== undefined)
		add(
			"personnel.brokerCount",
			"source-field",
			"证券经纪人数",
			dataset.personnel.brokerCount,
			[`证券经纪人${dataset.personnel.brokerCount}名`],
			referencedFieldEvidence(dataset, dataset.personnel.evidenceIds, "brokerCount"),
		);

	for (const appointment of dataset.appointments) {
		const recordId = appointment.documentNumber;
		for (const [field, label, value, variants] of [
			["personName", "任免人员", appointment.personName, [appointment.personName]],
			["title", "任免职务", appointment.title, [appointment.title]],
			["startDate", "任职开始日期", appointment.startDate, [chineseYearMonth(appointment.startDate)]],
			[
				"endDate",
				"任职结束日期",
				appointment.endDate ?? "",
				appointment.endDate ? [chineseYearMonth(appointment.endDate)] : [],
			],
			["issuer", "发文主体", appointment.issuer, [appointment.issuer]],
			["documentTitle", "任免文件标题", appointment.documentTitle, [appointment.documentTitle]],
			["documentNumber", "任免文件文号", appointment.documentNumber, [appointment.documentNumber]],
			["documentDate", "任免文件日期", appointment.documentDate, [chineseFullDate(appointment.documentDate)]],
		] as const) {
			if (String(value) === "") continue;
			add(
				`appointment.${recordId}.${field}`,
				"source-field",
				label,
				value,
				variants,
				referencedFieldEvidence(dataset, appointment.evidenceIds, field),
			);
		}
	}

	for (const metric of dataset.operatingMetrics) {
		for (const point of metric.points) {
			add(
				`metric.${metric.metricCode}.${point.period}.value`,
				"source-field",
				`${metric.reportLabel}${point.period}完成数`,
				point.value,
				[
					`${metric.reportLabel}${point.period}完成数${point.value}`,
					`${point.period}${metric.reportLabel.replace(/（.*?）/gu, "")}为${point.value}${metric.unit}`,
					`${metric.reportLabel}${point.period}完成数${point.value.toLocaleString("zh-CN", {
						minimumFractionDigits: 2,
						maximumFractionDigits: 2,
						useGrouping: true,
					})}`,
				],
				referencedFieldEvidence(dataset, point.evidenceIds, "value"),
			);
			const rankValue = point.rank ?? "—";
			add(
				`metric.${metric.metricCode}.${point.period}.rank`,
				"source-field",
				`${metric.reportLabel}${point.period}排名`,
				rankValue,
				[
					`${metric.reportLabel}${point.period}排名${rankValue}`,
					`${metric.reportLabel.replace(/（.*?）/gu, "")}${point.period}排名${rankValue}`,
				],
				referencedFieldEvidence(dataset, point.evidenceIds, "rank"),
			);
			if (point.participants !== undefined) {
				add(
					`metric.${metric.metricCode}.${point.period}.participants`,
					"source-field",
					`${point.period}参与排名营业部家数`,
					point.participants,
					[`${point.period}参与排名营业部家数为${point.participants}家`],
					referencedFieldEvidence(dataset, point.evidenceIds, "participants"),
				);
			}
		}
	}
	for (const code of ["client_assets", "stock_fund_volume"] as const) {
		const metric = dataset.operatingMetrics.find((item) => item.metricCode === code);
		if (!metric) continue;
		const trend = metricTrend(metric);
		if (!trend) continue;
		add(
			`derived.${code}.trend`,
			"derived-calculation",
			`${metric.reportLabel}趋势`,
			trend,
			[trend],
			metric.points.flatMap((point) => point.evidenceIds),
			false,
		);
	}
	if (dataset.task.reportType === "turnover") {
		const performanceMetrics = dataset.operatingMetrics.filter((metric) => metric.table === "performance");
		const hasFullYearFluctuation = performanceMetrics.some((metric) => {
			const values = metric.points.filter((point) => !point.period.includes("月")).map((point) => point.value);
			const increasing = values.every((value, index) => index === 0 || value >= (values[index - 1] ?? value));
			const decreasing = values.every((value, index) => index === 0 || value <= (values[index - 1] ?? value));
			return values.length >= 2 && !increasing && !decreasing;
		});
		if (hasFullYearFluctuation) {
			add(
				"derived.turnover-performance-trend",
				"derived-calculation",
				"离任报告完整年度业绩指标趋势",
				"总体有所波动",
				["完整年度各项业绩指标总体有所波动"],
				performanceMetrics.flatMap((metric) => metric.points.flatMap((point) => point.evidenceIds)),
				false,
			);
		}
	}
	if (dataset.operatingMetrics.length > 0) {
		const periods = dataset.operatingMetrics[0]?.points.map((point) => point.period) ?? [];
		add(
			"derived.operating-period",
			"derived-calculation",
			"经营数据期间",
			periods.join(".."),
			[`${periods.join("、")}主要经营情况`],
			dataset.operatingMetrics.flatMap((metric) => metric.points.flatMap((point) => point.evidenceIds)),
			false,
		);
		const participantCounts = periods.map(
			(period) =>
				dataset.operatingMetrics
					.flatMap((metric) => metric.points)
					.find((point) => point.period === period && point.participants !== undefined)?.participants,
		);
		if (participantCounts.every((value) => value !== undefined)) {
			add(
				"derived.ranking-participants",
				"derived-calculation",
				"参与排名营业部家数序列",
				participantCounts.join("、"),
				[`${periods.join("、")}，参与排名的营业部家数分别为${participantCounts.join("、")}`],
				dataset.operatingMetrics.flatMap((metric) => metric.points.flatMap((point) => point.evidenceIds)),
				false,
			);
		}
		const revenueCodes = new Set([
			"brokerage_net_revenue",
			"deposit_interest_net_revenue",
			"product_revenue",
			"margin_interest_revenue",
			"other_revenue",
		]);
		const lastPeriod = periods.at(-1);
		const revenueMetrics = dataset.operatingMetrics.filter((metric) => revenueCodes.has(metric.metricCode));
		const completeRevenue = [...revenueCodes].every((code) =>
			revenueMetrics.some(
				(metric) => metric.metricCode === code && metric.points.some((point) => point.period === lastPeriod),
			),
		);
		const latestRevenue = dataset.operatingMetrics
			.filter((metric) => revenueCodes.has(metric.metricCode))
			.map((metric) => ({
				metric,
				value: metric.points.find((point) => point.period === lastPeriod)?.value ?? Number.NEGATIVE_INFINITY,
			}))
			.sort((left, right) => right.value - left.value)[0];
		if (
			completeRevenue &&
			latestRevenue &&
			latestRevenue.value > 0 &&
			revenueMetrics.filter(
				(metric) => metric.points.find((point) => point.period === lastPeriod)?.value === latestRevenue.value,
			).length === 1
		) {
			const label = latestRevenue.metric.reportLabel.replace(/^其中：/u, "");
			add(
				"derived.primary-revenue",
				"derived-calculation",
				"主要收入来源",
				label,
				[`${lastPeriod}营业部以${label}为主要收入来源`],
				revenueMetrics.flatMap((metric) =>
					metric.points.filter((point) => point.period === lastPeriod).flatMap((point) => point.evidenceIds),
				),
				false,
			);
		}
		const bands = unique(
			dataset.operatingMetrics.flatMap((metric) =>
				metric.points.flatMap((point) => {
					if (point.rank === undefined || point.participants === undefined || point.participants <= 0) return [];
					const ratio = point.rank / point.participants;
					if (ratio <= 0.2) return ["上游"];
					if (ratio <= 0.4) return ["中上游"];
					if (ratio <= 0.6) return ["中游"];
					if (ratio <= 0.8) return ["中下游"];
					return ["下游"];
				}),
			),
		);
		const bandText =
			bands.length === 2 && bands.includes("中下游") && bands.includes("中游")
				? "中游至中下游"
				: bands.length > 0
					? bands.join("、")
					: "待确认";
		add(
			"derived.rank-band",
			"derived-calculation",
			"经营指标五档排名",
			bandText,
			[`排名基本处于公司所有营业部${bandText}水平`, `整体排名处于公司所有营业部${bandText}水平`],
			dataset.operatingMetrics.flatMap((metric) => metric.points.flatMap((point) => point.evidenceIds)),
			false,
		);
	}

	for (const finding of dataset.findings) {
		const findingClaims = finding.isHistorical
			? ([["title", "上一次审计问题标题", finding.title, [finding.title]]] as const)
			: ([
					["title", "审计问题标题", finding.title, [finding.title]],
					["policyBasis", "制度依据", finding.policyBasis, [finding.policyBasis]],
					["factText", "审计发现事实", finding.factText, [finding.factText]],
					// A statistics field does not establish the number or unit of affected business objects.
					["issueCount", "问题统计数量", finding.issueCount, [`问题数量为${finding.issueCount}`]],
				] as const);
		for (const [field, label, value, variants] of findingClaims) {
			if (value === undefined) continue;
			add(
				`finding.${finding.findingId}.${field}`,
				field === "factText" || field === "policyBasis" ? "source-narrative" : "source-field",
				`${finding.findingId}${label}`,
				value,
				variants,
				evidenceForField(dataset, "DS-03", finding.findingId, field),
			);
		}
		for (const [index, subitem] of (finding.internalSubitems ?? []).entries()) {
			add(
				`finding.${finding.findingId}.internalSubitem.${index + 1}`,
				"source-narrative",
				`${finding.findingId}内部子项${index + 1}`,
				subitem,
				[subitem, `（${index + 1}）${subitem}`],
				evidenceForField(dataset, "DS-03", finding.findingId, "internalSubitems"),
				false,
			);
		}
		if (finding.rectification) {
			const rectification = finding.rectification;
			add(
				`rectification.${rectification.rectificationId}.status`,
				"source-field",
				`${finding.findingId}整改状态`,
				rectification.status,
				[rectification.status],
				evidenceForField(dataset, "DS-03", rectification.rectificationId, "status"),
			);
		}
	}
	const findingCategories = unique(
		dataset.findings.filter((finding) => !finding.isHistorical).map((finding) => finding.category),
	);
	if (findingCategories.length > 0) {
		add(
			"derived.finding-categories",
			"derived-calculation",
			"审计问题分类集合",
			findingCategories.join("、"),
			[findingCategories.join("、")],
			dataset.findings.flatMap((finding) => finding.evidenceIds),
			false,
		);
		add(
			"derived.finding-presence",
			"derived-calculation",
			"存在审计发现问题",
			`${dataset.findings.length}`,
			["仍发现部分问题", "仍然发现存在部分问题", "存在以下不足"],
			dataset.findings.flatMap((finding) => finding.evidenceIds),
			false,
		);
	}
	if (dataset.task.reportType === "turnover") {
		// Generation decisions are not independent evidence for the evaluator.
		const previousFindings = dataset.findings.filter((finding) => finding.isHistorical);
		add(
			"previous.comparison.lead",
			"derived-calculation",
			"上一次与本次问题比对",
			"已完成两期问题逐项比对",
			["经与本次审计问题逐项比对"],
			previousFindings.flatMap((finding) => finding.evidenceIds),
			false,
		);
	}
	if (!dataset.findings.some((finding) => finding.severity === "重大")) {
		const conclusionEvidenceIds = unique([
			...dataset.findings.flatMap((finding) => finding.evidenceIds),
			...dataset.manualDecisions
				.filter((decision) => decision.fieldId === "turnover.conclusion")
				.flatMap((decision) => decision.evidenceIds),
		]);
		add(
			"derived.turnover-basic-compliance",
			"derived-calculation",
			"离任人员基本合规履职结论",
			"基本能够按照国家有关法规和公司规章制度的规定开展各项业务",
			["基本能够按照国家有关法规和公司规章制度的规定开展各项业务"],
			conclusionEvidenceIds,
			false,
		);
		add(
			"derived.turnover-duty-performance",
			"derived-calculation",
			"离任人员职责落实结论",
			"总体上落实了营业部管理责任和合规与风险管理职责",
			["总体上落实了营业部管理责任和合规与风险管理职责"],
			conclusionEvidenceIds,
			false,
		);
		add(
			"derived.no-major-finding",
			"derived-calculation",
			"未发现重大问题结论",
			"未发现重大违法违规事项或重大内控缺陷",
			[
				"未发现重大违法违规事项或重大内控缺陷",
				"不存在重大违法违规事项",
				"未发现营业部反洗钱工作存在重大或重要内控缺陷",
				"未发现其所在营业部经营活动及内部控制存在重大违法违规事项或重大内控缺陷",
				`未发现${organization.fullName}经营活动及内部控制存在重大违法违规事项或重大内控缺陷`,
				`未发现${organization.fullName}反洗钱工作存在重大违法违规事项或重大内控缺陷`,
			],
			conclusionEvidenceIds,
			false,
		);
	}

	const absenceLabels: Readonly<Record<string, string>> = {
		"security-incident": "重大信息安全事故",
		"major-emergency": "重大突发事件",
		complaint: "未了结客户投诉",
		lawsuit: "未决诉讼",
	};
	for (const event of dataset.riskEvents) {
		if (event.description) {
			add(
				`risk.${event.eventId}.description`,
				"source-narrative",
				`${event.type}风险事项`,
				event.description,
				[event.description],
				evidenceForField(dataset, "DS-08", event.eventId, "description"),
			);
		}
		if (event.state === "VERIFIED_NONE" && absenceLabels[event.type]) {
			add(
				`risk.${event.eventId}.none`,
				"source-field",
				`${event.type}无事项状态`,
				event.state,
				[`未发生${absenceLabels[event.type]}`, absenceLabels[event.type] ?? ""],
				evidenceForField(dataset, "DS-08", event.eventId, "state"),
			);
		}
	}

	for (const domain of dataset.aml?.domains ?? []) {
		add(
			`aml.${domain.domain}.summary`,
			"source-narrative",
			`${domain.domain}反洗钱领域事实`,
			domain.summary,
			[domain.summary],
			unique([
				...referencedFieldEvidence(dataset, domain.evidenceIds, `${domain.domain}.summary`),
				...referencedFieldEvidence(dataset, domain.evidenceIds, "summary"),
			]),
		);
	}
	if (dataset.aml) {
		add(
			"aml.suspiciousTransactionCount",
			"source-field",
			"可疑交易数量",
			dataset.aml.suspiciousTransactionCount,
			[`共${dataset.aml.suspiciousTransactionCount}笔`],
			referencedFieldEvidence(dataset, dataset.aml.evidenceIds, "suspiciousTransactionCount"),
		);
		add(
			"aml.suspiciousTransactionType",
			"source-field",
			"可疑交易类型",
			dataset.aml.suspiciousTransactionType,
			[dataset.aml.suspiciousTransactionType],
			referencedFieldEvidence(dataset, dataset.aml.evidenceIds, "suspiciousTransactionType"),
		);
		add(
			"aml.suspiciousTransactionGeneralCount",
			"source-field",
			"一般可疑交易数量",
			dataset.aml.generalSuspiciousTransactionCount,
			[`${dataset.aml.generalSuspiciousTransactionCount}笔为一般可疑交易`],
			referencedFieldEvidence(dataset, dataset.aml.evidenceIds, "generalSuspiciousTransactionCount"),
		);
		add(
			"aml.suspiciousTransactionKeyCount",
			"source-field",
			"重点可疑交易数量",
			dataset.aml.keySuspiciousTransactionCount,
			[`${dataset.aml.keySuspiciousTransactionCount}笔为重点可疑交易`],
			referencedFieldEvidence(dataset, dataset.aml.evidenceIds, "keySuspiciousTransactionCount"),
		);
		const newAccountEvidence = dataset.aml.newAccountRiskRecords.flatMap((record) => record.evidenceIds);
		const periodicEvidence = dataset.aml.periodicReviewRecords.flatMap((record) => record.evidenceIds);
		const letterEvidence = dataset.aml.regulatoryLetters.flatMap((record) => record.evidenceIds);
		const newAccountSample = dataset.aml.newAccountRiskRecords.reduce((sum, record) => sum + record.sampleCount, 0);
		const newAccountExceptions = dataset.aml.newAccountRiskRecords.reduce(
			(sum, record) => sum + record.exceptionCount,
			0,
		);
		const newAccountOverdue = dataset.aml.newAccountRiskRecords.filter((record) => record.overdue).length;
		const periodicSample = dataset.aml.periodicReviewRecords.reduce((sum, record) => sum + record.sampleCount, 0);
		const periodicExceptions = dataset.aml.periodicReviewRecords.reduce(
			(sum, record) => sum + record.exceptionCount,
			0,
		);
		const periodicOverdue = dataset.aml.periodicReviewRecords
			.filter((record) => record.overdue)
			.reduce((sum, record) => sum + record.exceptionCount, 0);
		const letterCount = dataset.aml.regulatoryLetters.filter((record) => record.inScope).length;
		const letterOverdue = dataset.aml.regulatoryLetters.filter((record) => record.inScope && record.overdue).length;
		const adjustedLetters = dataset.aml.regulatoryLetters.filter(
			(record) => record.inScope && record.riskAdjustmentStatus === "已调整",
		).length;
		add(
			"aml.newAccount.sample",
			"derived-calculation",
			"新开户风险等级划分抽查数",
			newAccountSample,
			[
				`新开户风险等级划分抽查${newAccountSample}笔`,
				`抽查新开户客户${newAccountSample}笔`,
				`（1）抽查新开户客户${newAccountSample}笔`,
			],
			newAccountEvidence,
			false,
		);
		add(
			"aml.newAccount.exceptions",
			"derived-calculation",
			"新开户风险等级划分异常数",
			newAccountExceptions,
			[`发现${newAccountExceptions}笔异常`],
			newAccountEvidence,
			false,
		);
		add(
			"aml.newAccount.overdue",
			"derived-calculation",
			"新开户风险等级划分超期数",
			newAccountOverdue,
			[`其中${newAccountOverdue}笔流程超期`],
			newAccountEvidence,
			false,
		);
		add(
			"aml.periodicReview.sample",
			"derived-calculation",
			"定期审核抽查数",
			periodicSample,
			[
				`定期审核抽查${periodicSample}笔`,
				`抽查高风险客户定期审核${periodicSample}笔`,
				`（1）抽查高风险客户定期审核${periodicSample}笔`,
			],
			periodicEvidence,
			false,
		);
		add(
			"aml.periodicReview.exceptions",
			"derived-calculation",
			"定期审核异常数",
			periodicExceptions,
			[`发现${periodicExceptions}笔异常`],
			periodicEvidence,
			false,
		);
		add(
			"aml.periodicReview.overdue",
			"derived-calculation",
			"定期审核超期数",
			periodicOverdue,
			[`其中${periodicOverdue}笔审核超期`],
			periodicEvidence,
			false,
		);
		add(
			"aml.regulatoryLetters.count",
			"derived-calculation",
			"反洗钱函件数量",
			letterCount,
			[`收到反洗钱协查函及警示函${letterCount}件`],
			letterEvidence,
			false,
		);
		add(
			"aml.regulatoryLetters.overdue",
			"derived-calculation",
			"反洗钱函件超期数",
			letterOverdue,
			[`其中${letterOverdue}件录入或复核超期`],
			letterEvidence,
			false,
		);
		add(
			"aml.regulatoryLetters.adjusted",
			"derived-calculation",
			"风险动态调整数量",
			adjustedLetters,
			[`${adjustedLetters}件已完成客户风险动态调整`],
			letterEvidence,
			false,
		);
		const majorEvidence = [
			...dataset.aml.evidenceIds,
			...dataset.aml.majorMatters.flatMap((matter) => matter.evidenceIds),
		];
		if (
			dataset.aml.problemQueryComplete &&
			dataset.aml.majorMatterQueryComplete &&
			!dataset.aml.majorMatters.some((m) => m.confirmedMajor) &&
			!dataset.findings.some(
				(f) => !f.isHistorical && f.category === "反洗钱工作" && (f.majorConfirmed || f.severity === "重大"),
			)
		)
			add(
				"aml.majorMatter.none",
				"derived-calculation",
				"重大事项查询结果",
				dataset.aml.majorMatters.filter((matter) => matter.confirmedMajor).length,
				[
					"未发现营业部反洗钱工作存在重大或重要内控缺陷",
					`未发现${dataset.organization.fullName}反洗钱工作存在重大违法违规事项或重大内控缺陷`,
					`未发现${dataset.organization.fullName}在反洗钱工作方面存在重大违法违规事项或重大内控缺陷`,
				],
				majorEvidence,
				false,
			);
		const currentAmlFindings = dataset.findings.filter(
			(finding) =>
				finding.category === "反洗钱工作" &&
				!finding.isHistorical &&
				finding.projectId === dataset.task.projectId &&
				finding.organizationId === dataset.task.organizationId,
		);
		add(
			"aml.finding-presence",
			"derived-calculation",
			"本项目存在反洗钱问题",
			currentAmlFindings.length,
			["营业部反洗钱工作存在以下问题"],
			currentAmlFindings.flatMap((finding) => finding.evidenceIds),
			false,
		);
		if (currentAmlFindings.length > 0) {
			add(
				"aml.finding-count",
				"derived-calculation",
				"反洗钱问题数量词",
				dataset.findings.filter((finding) => finding.category === "反洗钱工作" && !finding.isHistorical).length,
				["但仍存在个别问题", "但仍存在部分问题", "但仍然发现个别问题", "但仍然发现部分问题"],
				dataset.findings
					.filter((finding) => finding.category === "反洗钱工作" && !finding.isHistorical)
					.flatMap((finding) => finding.evidenceIds),
				false,
			);
		}
		add(
			"aml.overview",
			"derived-calculation",
			"反洗钱基础工作总体状态",
			"六个反洗钱领域均已取得数据",
			["成立反洗钱工作小组，制订反洗钱工作制度，建立日常工作机制并开展相关工作"],
			dataset.aml.domains.flatMap((domain) => domain.evidenceIds),
			false,
		);
	}

	for (const record of dataset.performance) {
		if (dataset.task.reportType === "turnover" && record.personId !== dataset.task.subjectPersonId) continue;
		const recordId = `${record.personId}-${record.year}`;
		add(
			`performance.${recordId}.rating`,
			"source-field",
			`${record.year}年度绩效考核结果`,
			record.rating,
			[`${record.year}年度${record.rating}`],
			referencedFieldEvidence(dataset, record.evidenceIds, "rating"),
		);
	}
	for (const personId of new Set(dataset.performance.map((r) => r.personId))) {
		if (dataset.task.reportType === "turnover" && personId !== dataset.task.subjectPersonId) continue;
		const appointments = dataset.appointments.filter((a) => a.personId === personId);
		const names = [...new Set(appointments.map((a) => a.personName))];
		if (names.length !== 1 || !names[0]) continue;
		const rows = dataset.performance
			.filter((r) => r.personId === personId)
			.slice()
			.sort((a, b) => a.year - b.year);
		if (new Set(rows.map((r) => r.year)).size !== rows.length) continue;
		const contiguous = rows.every((r, i) => i === 0 || r.year === rows[i - 1]!.year + 1);
		const groups = contiguous ? [rows] : rows.map((r) => [r]);
		for (const group of groups) {
			const first = group[0]!;
			const same = group.every((r) => r.rating === first.rating);
			const period = group.length === 1 ? `${first.year}` : `${first.year}—${group.at(-1)!.year}`;
			const result =
				group.length === 1
					? `为${first.rating}`
					: same
						? `均为${first.rating}`
						: `分别为${group.map((r) => r.rating).join("、")}`;
			add(
				`performance.sequence.${personId}.${first.year}`,
				"derived-calculation",
				"个人年度绩效序列",
				group.map((r) => r.rating).join("、"),
				[`${period}年度，公司对${names[0]}同志的绩效考核结果${result}`],
				[...group.flatMap((r) => r.evidenceIds), ...appointments.flatMap((a) => a.evidenceIds)],
				false,
			);
		}
	}

	for (const decision of dataset.manualDecisions) {
		add(
			`manual.${decision.decisionId}.selectedValue`,
			"source-field",
			`人工确认${decision.fieldId}`,
			decision.selectedValue,
			[decision.selectedValue],
			evidenceForField(dataset, "DS-08", decision.decisionId, "selectedValue"),
		);
	}

	for (const [field, value] of Object.entries(dataset.fixedFacts)) {
		if (["internalControlSummary", "cleanPracticeSummary"].includes(field)) continue; // Independently checked against original checklist fields.
		add(
			`narrative.${field}`,
			"source-narrative",
			`审计叙述事实${field}`,
			value,
			[value],
			[
				...evidenceForField(dataset, "DS-10", organization.organizationId, field),
				...(field === "auditProcedures" ? evidenceForField(dataset, "DS-10", dataset.task.templateId, field) : []),
			],
		);
	}
	return candidates;
}

function evidenceReferences(
	dataset: AuditReportDataset,
	evidenceIds: readonly string[],
): ReportClaimVerification["evidence"] {
	const sourceNames = new Map(dataset.sources.map((source) => [source.sourceId, source.name]));
	const records = new Map(dataset.evidence.map((record) => [record.evidenceId, record]));
	return unique(evidenceIds)
		.map((id) => records.get(id))
		.filter((record): record is EvidenceRecord => record !== undefined)
		.map((record) => ({
			evidenceId: record.evidenceId,
			sourceId: record.sourceId,
			sourceName: sourceNames.get(record.sourceId) ?? record.sourceId,
			sourceRecordId: record.sourceRecordId,
			sourceField: record.sourceField,
			rawValue: record.rawValue,
			normalizedValue: record.normalizedValue,
			asOf: record.asOf,
			dataVersion: record.dataVersion,
		}));
}

function numericTokens(value: string): string[] {
	return unique(
		value
			.replace(/,/gu, "")
			.replace(/^\s*\d+\./u, "")
			.match(/\d+(?:\.\d+)?%?/gu) ?? [],
	);
}

function directEvidenceForClause(
	dataset: AuditReportDataset,
	clause: string,
	paragraphEvidenceIds: readonly string[],
): EvidenceRecord[] {
	const normalizedClause = normalize(clause);
	if (normalizedClause.length < 4) return [];
	const allowedEvidenceIds = new Set(paragraphEvidenceIds);
	return dataset.evidence.filter((record) => {
		if (!allowedEvidenceIds.has(record.evidenceId)) return false;
		const rawValue = normalize(record.rawValue);
		const normalizedValue = normalize(record.normalizedValue);
		return rawValue.includes(normalizedClause) || normalizedValue.includes(normalizedClause);
	});
}

function verifyControlSentence(dataset: AuditReportDataset, input: SentenceInput): ReportClaimVerification {
	// Independent evaluator: do not import the generator or accept its upstream summary as the answer.
	const cleanPractice = input.location.includes("turnover-clean-practice");
	const expected: { text: string; ids: string[] }[] = [];
	const resultIds: string[] = [];
	const recordIds = new Set<string>();
	let valid = true;
	let conforming = 0;
	let exceptions = 0;
	let inapplicable = 0;
	const basicControlsConform = ["岗位设置", "不相容职务分离", "授权审批", "财产保护", "预算控制"].every((code) => {
		const rows = (dataset.checks ?? []).filter((check) => check.code === code);
		return rows.length === 1 && rows[0]?.result === "conforming";
	});
	for (const code of cleanPractice ? ["廉洁从业管理", "信访及案件"] : REGULAR_CHECKS) {
		const matches = (dataset.checks ?? []).filter((check) => check.code === code);
		const check = matches[0];
		if (matches.length !== 1 || !check || !["conforming", "exception", "not-applicable"].includes(check.result)) {
			valid = false;
			continue;
		}
		const result = dataset.evidence.filter(
			(proof) =>
				check.evidenceIds.includes(proof.evidenceId) &&
				proof.sourceField === "result" &&
				proof.sourceId === "DS-03",
		);
		const proof = result[0];
		if (
			result.length !== 1 ||
			!proof ||
			proof.normalizedValue !== check.result ||
			!proof.dataVersion ||
			!proof.sourceRecordId ||
			recordIds.has(proof.sourceRecordId)
		) {
			valid = false;
			continue;
		}
		recordIds.add(proof.sourceRecordId);
		resultIds.push(proof.evidenceId);
		if (cleanPractice) {
			const refs = [proof.evidenceId];
			const label =
				check.result === "conforming" ? "符合要求" : check.result === "exception" ? "存在异常" : "不适用";
			let detail = `${code}检查结果：${label}`;
			if (check.result !== "conforming" || check.factText?.trim()) {
				const facts = dataset.evidence.filter(
					(e) =>
						check.evidenceIds.includes(e.evidenceId) && e.sourceId === "DS-03" && e.sourceField === "factText",
				);
				const fact = facts[0];
				if (
					facts.length !== 1 ||
					!fact ||
					!check.factText?.trim() ||
					fact.normalizedValue !== check.factText ||
					fact.sourceRecordId !== proof.sourceRecordId ||
					fact.dataVersion !== proof.dataVersion
				)
					valid = false;
				else {
					detail = check.result === "conforming" ? check.factText.trim() : `${detail}，${check.factText.trim()}`;
					refs.push(fact.evidenceId);
				}
			}
			for (const sentence of splitSentences(detail)) expected.push({ text: sentence, ids: refs });
			continue;
		}
		if (check.result === "conforming") conforming++;
		else {
			if (check.result === "exception") exceptions++;
			else inapplicable++;
			const facts = dataset.evidence.filter(
				(item) =>
					check.evidenceIds.includes(item.evidenceId) &&
					item.sourceId === "DS-03" &&
					item.sourceField === "factText",
			);
			const fact = facts[0];
			if (
				facts.length !== 1 ||
				!fact ||
				!check.factText?.trim() ||
				fact.normalizedValue !== check.factText ||
				fact.sourceRecordId !== proof.sourceRecordId ||
				fact.dataVersion !== proof.dataVersion
			)
				valid = false;
			else {
				const detail =
					basicControlsConform && check.result === "exception"
						? check.factText.trim()
						: `${code}：${check.result === "exception" ? "存在异常" : "不适用"}，${check.factText.trim()}`;
				for (const sentence of splitSentences(detail))
					expected.push({ text: sentence, ids: [proof.evidenceId, fact.evidenceId] });
			}
		}
	}
	if (!cleanPractice)
		expected.unshift({
			text: basicControlsConform
				? "经审计，营业部岗位设置符合内部控制基本要求，并在业务运行过程中基本落实了不相容职务分离控制、授权审批控制、财产保护控制、预算控制等内部控制措施。"
				: `内部控制检查共涉及${REGULAR_CHECKS.length}项，其中${conforming}项符合要求、${exceptions}项存在异常、${inapplicable}项不适用。`,
			ids: resultIds,
		});
	const controlText = (value: string) => value.replace(/[\s,，:：;；。！？]+/gu, "");
	const matched = expected.find((item) => controlText(item.text) === controlText(input.text));
	const bound =
		matched !== undefined && matched.ids.length > 0 && matched.ids.every((id) => input.evidenceIds.includes(id));
	return {
		claimId: `${cleanPractice ? "clean-practice-checks" : "control-checks"}@${input.location}`,
		claimType: "derived-calculation",
		claimText: cleanPractice ? "廉洁从业及信访案件检查结果与说明" : "内部控制检查数量、结果及说明",
		expectedValue: matched?.text ?? expected.map((item) => item.text).join(""),
		actualValue: input.text,
		value: valid && bound ? 1 : 0,
		reason: !valid
			? "原始检查结果或依据不完整、不一致"
			: !matched
				? "段落内容与原始检查记录重新计算的结果不一致"
				: !bound
					? "段落未绑定该主张所需的全部检查依据"
					: "已独立核对检查记录、统计口径及段落引用",
		evidence: evidenceReferences(dataset, matched?.ids ?? resultIds),
	};
}

function verifyUnpublishedPerformanceSentence(
	dataset: AuditReportDataset,
	input: SentenceInput,
): ReportClaimVerification {
	// Reconstruct the declaration from source fields independently of the generation helper.
	const state = dataset.performanceAvailability;
	const expected = "任期内尚无已发布的年度考核结果。";
	const proofs: EvidenceRecord[] = [];
	let valid = Boolean(
		state?.status === "not-published" &&
			dataset.task.reportType === "turnover" &&
			state.personId &&
			state.personId === dataset.task.subjectPersonId &&
			dataset.performance.length === 0 &&
			input.location.includes("paragraph[turnover-performance]") &&
			input.text === expected,
	);
	if (state) {
		for (const date of [state.periodStart, state.periodEnd]) {
			if (
				!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
				!Number.isFinite(Date.parse(date)) ||
				new Date(date).toISOString().slice(0, 10) !== date
			)
				valid = false;
		}
		if (state.periodStart > state.periodEnd) valid = false;
		for (const [source, field, raw, normalized] of [
			["DS-09", "noPublishedAnnualResults", "true", "not-published"],
			["DS-03", "personId", state.personId, state.personId],
			["DS-03", "responsibilityStart", state.periodStart, state.periodStart],
			["DS-03", "responsibilityEnd", state.periodEnd, state.periodEnd],
		]) {
			const matches = dataset.evidence.filter(
				(e) => state.evidenceIds.includes(e.evidenceId) && e.sourceId === source && e.sourceField === field,
			);
			if (matches.length !== 1 || matches[0]?.rawValue !== raw || matches[0]?.normalizedValue !== normalized)
				valid = false;
			proofs.push(...matches);
		}
	}
	if (
		proofs.length !== 4 ||
		proofs.some((e) => !e.sourceRecordId || !e.dataVersion || !input.evidenceIds.includes(e.evidenceId)) ||
		new Set(proofs.map((e) => e.sourceRecordId)).size !== 1 ||
		new Set(proofs.map((e) => e.dataVersion)).size !== 1
	)
		valid = false;
	return {
		claimId: `performance-availability@${input.location}`,
		claimType: "source-field",
		claimText: "任期内尚无已发布年度考核结果的业务声明",
		expectedValue: expected,
		actualValue: input.text,
		value: valid ? 1 : 0,
		reason: valid
			? "已独立核对暂无结果声明、人员、任期及同版本原始字段；不是根据空考核表推断"
			: "暂无结果声明、人员任期或段落引用不一致",
		evidence: evidenceReferences(
			dataset,
			proofs.map((e) => e.evidenceId),
		),
	};
}

function verifyPerformanceSentence(
	dataset: AuditReportDataset,
	input: SentenceInput,
	candidates: readonly ClaimCandidate[],
): ReportClaimVerification {
	const matched = candidates.filter(
		(c) =>
			c.key.startsWith("performance.sequence.") && c.variants.some((v) => normalize(v) === normalize(input.text)),
	);
	const candidate = matched.length === 1 ? matched[0] : undefined;
	const proofs = dataset.evidence.filter((e) => candidate?.evidenceIds.includes(e.evidenceId));
	const rows = dataset.performance.filter((r) =>
		r.evidenceIds.some((id) => proofs.some((e) => e.sourceId === "DS-09" && e.evidenceId === id)),
	);
	const personId = rows[0]?.personId;
	let valid = Boolean(candidate && rows.length && rows.every((r) => r.personId === personId));
	const ids: string[] = [];
	for (const row of rows) {
		if (!Number.isInteger(row.year) || row.year < 1900 || row.year > 9999 || !row.rating.trim()) valid = false;
		const fields: EvidenceRecord[] = [];
		for (const field of ["personId", "year", "rating"] as const) {
			const found = proofs.filter(
				(e) => e.sourceId === "DS-09" && e.sourceField === field && row.evidenceIds.includes(e.evidenceId),
			);
			if (found.length !== 1 || found[0]?.normalizedValue !== String(row[field])) valid = false;
			else fields.push(found[0]);
		}
		if (
			fields.length !== 3 ||
			fields.some((e) => !e.sourceRecordId || !e.dataVersion) ||
			new Set(fields.map((e) => e.sourceRecordId)).size !== 1 ||
			new Set(fields.map((e) => e.dataVersion)).size !== 1
		)
			valid = false;
		ids.push(...fields.map((e) => e.evidenceId));
	}
	const names = [
		...new Set(dataset.appointments.filter((a) => a.personId === personId).map((a) => a.personName.trim())),
	];
	const nameProof = proofs.find(
		(e) =>
			e.sourceField === "personName" &&
			e.normalizedValue === names[0] &&
			e.dataVersion &&
			((e.sourceId === "DS-02" && e.sourceRecordId === personId) ||
				(e.sourceId === "DS-05" &&
					proofs.some(
						(p) =>
							p.sourceId === "DS-05" &&
							p.sourceField === "personId" &&
							p.normalizedValue === personId &&
							p.sourceRecordId === e.sourceRecordId &&
							p.dataVersion === e.dataVersion,
					))),
	);
	if (names.length !== 1 || !names[0] || !nameProof) valid = false;
	if (
		dataset.task.reportType === "turnover" &&
		(personId !== dataset.task.subjectPersonId || names[0] !== dataset.task.subjectPersonName)
	)
		valid = false;
	if (nameProof) {
		ids.push(nameProof.evidenceId);
		if (nameProof.sourceId === "DS-05")
			ids.push(
				...proofs
					.filter(
						(p) =>
							p.sourceId === "DS-05" &&
							p.sourceField === "personId" &&
							p.sourceRecordId === nameProof.sourceRecordId &&
							p.dataVersion === nameProof.dataVersion &&
							p.normalizedValue === personId,
					)
					.map((p) => p.evidenceId),
			);
	}
	const bound = ids.length > 0 && ids.every((id) => input.evidenceIds.includes(id));
	return {
		claimId: `performance-source-check@${input.location}`,
		claimType: "derived-calculation",
		claimText: "负责人姓名与逐年绩效考核结果",
		expectedValue: candidate?.variants[0] ?? "与被审计人员及年度对应的原始考核记录",
		actualValue: input.text,
		value: valid && bound ? 1 : 0,
		reason: valid && bound ? "已核对人员、年度、结果及同一版本的字段依据" : "考核表述、字段值或段落依据缺失、不一致",
		evidence: evidenceReferences(dataset, ids),
	};
}

function verifyOperatingSentence(
	dataset: AuditReportDataset,
	input: SentenceInput,
	candidates: readonly ClaimCandidate[],
): ReportClaimVerification {
	// Match the entire factual clause, not just a name or a number embedded in an unsupported assertion.
	const allowed = candidates.filter(
		(c) =>
			c.key === "derived.primary-revenue" ||
			c.key === "derived.rank-band" ||
			/^derived\.(?:client_assets|stock_fund_volume)\.trend$/u.test(c.key) ||
			/^metric\..*\.value$/u.test(c.key),
	);
	const ignored = new Set(
		[
			"审计期内",
			"财务指标方面",
			"业绩指标方面",
			"从指标排名情况来看",
			`${dataset.task.subjectPersonName ?? ""}同志任职期内`,
		].map(normalize),
	);
	const ids: string[] = [];
	const errors: string[] = [];
	for (const clause of splitClauses(input.text)) {
		let content = normalize(clause);
		if (ignored.has(content)) continue;
		content = content.replace(/^营业部各项指标/u, "");
		const matches = allowed.filter((c) => c.variants.some((v) => normalize(v) === content));
		if (!matches.length) errors.push(`无法由可比期间和指标计算证明：${clause}`);
		for (const candidate of matches) {
			if (!candidate.evidenceIds.length || candidate.evidenceIds.some((id) => !input.evidenceIds.includes(id)))
				errors.push("未完整引用计算依据");
			ids.push(...candidate.evidenceIds);
		}
	}
	// Independently compare all used numeric source fields with the input metrics; generation text is not evidence.
	for (const metric of dataset.operatingMetrics)
		for (const point of metric.points) {
			if (!point.evidenceIds.some((id) => ids.includes(id))) continue;
			for (const field of ["value", "rank", "participants"] as const) {
				if (point[field] === undefined) continue;
				const proofs = dataset.evidence.filter(
					(e) => point.evidenceIds.includes(e.evidenceId) && e.sourceId === "DS-04" && e.sourceField === field,
				);
				if (
					proofs.length !== 1 ||
					!proofs[0]?.sourceRecordId ||
					!proofs[0]?.dataVersion ||
					!proofs[0]?.normalizedValue.trim() ||
					Number(proofs[0]?.normalizedValue) !== point[field] ||
					!proofs[0]?.rawValue.trim() ||
					Number(proofs[0]?.rawValue) !== point[field]
				)
					errors.push(`指标${metric.metricCode}的${field}来源不一致`);
			}
		}
	return {
		claimId: `operating-source-check@${input.location}`,
		claimType: "derived-calculation",
		claimText: "经营期间、趋势、收入来源及排名",
		expectedValue: "同口径期间计算及对应原始指标记录",
		actualValue: input.text,
		value: errors.length === 0 && ids.length > 0 ? 1 : 0,
		reason: errors.length
			? unique(errors).join("；")
			: "已核对完整分句、可比期间及原始数值，未将季度累计数作为年度趋势",
		evidence: evidenceReferences(dataset, ids),
	};
}

function verifyMetricCell(dataset: AuditReportDataset, input: SentenceInput): ReportClaimVerification {
	const cell = input.cell!;
	const field = cell.tableId === "ranking" ? "rank" : "value";
	const errors: string[] = [];
	const label = (text: string) => normalize(text.replace(/^其中[：:]/u, "").replace(/（.*?）/gu, ""));
	const metrics = dataset.operatingMetrics.filter(
		(metric) =>
			(cell.tableId === "ranking" || metric.table === cell.tableId) &&
			label(metric.reportLabel) === label(cell.label),
	);
	const metric = metrics.length === 1 ? metrics[0] : undefined;
	const suffix = field === "rank" ? "排名" : "完成数";
	const period = cell.header.endsWith(suffix) ? cell.header.slice(0, -suffix.length) : "";
	const points = metric?.points.filter((point) => normalize(point.period) === normalize(period)) ?? [];
	const point = points.length === 1 ? points[0] : undefined;
	if (!metric || !point || !period) errors.push("单元格指标、表类别或期间无法唯一定位");
	const proofs = dataset.evidence.filter(
		(e) => point?.evidenceIds.includes(e.evidenceId) && e.sourceId === "DS-04" && e.sourceField === field,
	);
	const proof = proofs.length === 1 ? proofs[0] : undefined;
	if (!proof?.sourceRecordId || !proof.dataVersion || !input.evidenceIds.includes(proof.evidenceId))
		errors.push("缺少单元格对应的字段级引用或版本信息");
	const value = point?.[field];
	let expected = "未定位";
	if (point && value === undefined && field === "rank") {
		expected = "—";
		if (!proof || !["", "null", "—"].includes(proof.rawValue) || !["", "null", "—"].includes(proof.normalizedValue))
			errors.push("缺少排名为空的原始字段，不能推断无排名");
		if (cell.value !== expected) errors.push("缺失排名未使用占位符");
	} else if (value !== undefined && Number.isFinite(value)) {
		// First check original precision against the input, then apply the report's two-decimal display rule.
		// Do not compare formatted output with an unrounded database decimal string or remove its minus sign.
		if (
			!proof ||
			!proof.rawValue.trim() ||
			!proof.normalizedValue.trim() ||
			Number(proof.rawValue) !== value ||
			Number(proof.normalizedValue) !== value
		)
			errors.push("原始数值、规范化数值与输入指标不一致");
		expected =
			field === "rank"
				? String(value)
				: value.toLocaleString("zh-CN", {
						minimumFractionDigits: 2,
						maximumFractionDigits: 2,
						useGrouping: false,
					});
		const actual = cell.value.trim().replace(/−/gu, "-");
		const validFormat =
			field === "rank" ? /^\d+$/u.test(actual) : /^-?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/u.test(actual);
		if (!validFormat || actual.replace(/,/gu, "") !== expected) errors.push("单元格数值、符号或显示精度不一致");
		if (field === "rank" && (!Number.isSafeInteger(value) || value < 1)) errors.push("排名不是正整数");
	} else errors.push("指标值不是有效数值");
	return {
		claimId: `metric-cell@${input.location}`,
		claimType: field === "rank" ? "source-field" : "derived-calculation",
		claimText: `${cell.label} ${cell.header}`,
		expectedValue: expected,
		actualValue: cell.value,
		value: errors.length === 0 ? 1 : 0,
		reason: errors.length ? errors.join("；") : "已独立核对指标、期间、原始精度及显示值；未提取单元格之外的主张",
		evidence: evidenceReferences(
			dataset,
			proofs.map((e) => e.evidenceId),
		),
	};
}

function verifyEstablishmentSentence(dataset: AuditReportDataset, input: SentenceInput): ReportClaimVerification {
	const organization = dataset.organization;
	const proofs = dataset.evidence.filter(
		(e) =>
			e.sourceId === "DS-01" &&
			e.sourceRecordId === organization.organizationId &&
			organization.evidenceIds.includes(e.evidenceId) &&
			e.sourceField === "establishedDate",
	);
	const proof = proofs[0];
	const date = proof?.rawValue ?? "";
	const validDate =
		/^\d{4}-\d{2}-\d{2}$/u.test(date) &&
		Number.isFinite(Date.parse(date)) &&
		new Date(date).toISOString().slice(0, 10) === date;
	const identities = dataset.evidence.filter(
		(e) =>
			e.sourceId === "DS-01" &&
			e.sourceRecordId === organization.organizationId &&
			organization.evidenceIds.includes(e.evidenceId) &&
			e.sourceField === "organizationCode",
	);
	const identity = identities[0];
	const expected = validDate ? `营业部于${chineseFullDate(date)}成立。` : "有效的营业部成立日期原始字段";
	const ids = [...proofs, ...identities].map((e) => e.evidenceId);
	const valid = Boolean(
		proofs.length === 1 &&
			identities.length === 1 &&
			validDate &&
			proof &&
			identity &&
			organization.organizationId === dataset.task.organizationId &&
			proof.normalizedValue === date &&
			date <= dataset.task.auditEnd &&
			proof.dataVersion &&
			identity.dataVersion === proof.dataVersion &&
			identity.rawValue === organization.organizationCode &&
			identity.normalizedValue === organization.organizationCode &&
			proof.asOf === organization.asOf &&
			identity.asOf === organization.asOf &&
			ids.every((id) => input.evidenceIds.includes(id)) &&
			input.text === expected,
	);
	return {
		claimId: `organization-establishment@${input.location}`,
		claimType: "derived-calculation",
		claimText: "营业部成立日期",
		expectedValue: expected,
		actualValue: input.text,
		value: valid ? 1 : 0,
		reason: valid
			? "已独立核验成立日期、同版本营业部身份及段落引用"
			: "成立日期、营业部归属、数据版本或段落引用不一致",
		evidence: evidenceReferences(dataset, ids),
	};
}

function verifyHistoricalInventory(dataset: AuditReportDataset, input: SentenceInput): ReportClaimVerification {
	const rows = dataset.findings.filter((finding) => finding.isHistorical);
	const projects = new Set(rows.map((row) => row.projectId));
	const counts = dataset.evidence.filter(
		(e) => e.sourceId === "DS-03" && e.sourceField === "previousQueryReturnedRecordCount",
	);
	const count = counts[0];
	const ids: string[] = counts.map((e) => e.evidenceId);
	let valid = Boolean(
		rows.length > 0 &&
			new Set(rows.map((row) => row.findingId)).size === rows.length &&
			projects.size === 1 &&
			!projects.has(dataset.task.projectId) &&
			counts.length === 1 &&
			count?.dataVersion &&
			projects.has(count.sourceRecordId) &&
			count.rawValue === String(rows.length) &&
			count.normalizedValue === String(rows.length),
	);
	for (const row of rows) {
		const titles = dataset.evidence.filter(
			(e) =>
				e.sourceId === "DS-03" &&
				e.sourceRecordId === row.findingId &&
				e.sourceField === "title" &&
				row.evidenceIds.includes(e.evidenceId),
		);
		const title = titles[0];
		if (
			row.organizationId !== dataset.task.organizationId ||
			!row.title.trim() ||
			titles.length !== 1 ||
			!title?.dataVersion ||
			title.rawValue !== row.title ||
			title.normalizedValue !== row.title
		)
			valid = false;
		ids.push(...titles.map((e) => e.evidenceId));
	}
	const inventory = `${rows.map((row) => row.title).join("、")}等问题。`;
	const expected = [
		`前次审计发现的问题主要包括：${inventory}`,
		`审计中心上一次对该营业部开展审计发现的问题主要包括：${inventory}`,
	];
	const textMatches = expected.includes(input.text);
	const bound = ids.length > 0 && ids.every((id) => input.evidenceIds.includes(id));
	return {
		claimId: `historical-inventory@${input.location}`,
		claimType: "derived-calculation",
		claimText: "前次审计问题清单及查询记录数",
		expectedValue: expected[dataset.task.reportType === "turnover" ? 1 : 0]!,
		actualValue: input.text,
		value: valid && textMatches && bound ? 1 : 0,
		reason: !valid
			? "历史问题身份、标题原始字段或查询数量不一致"
			: !textMatches
				? "历史问题清单有遗漏、增写、顺序变化或额外范围断言"
				: !bound
					? "段落未引用全部历史标题及查询数量依据"
					: "已独立逐项核对历史标题、项目、数量与段落引用，未使用生成摘要作答案",
		evidence: evidenceReferences(dataset, ids),
	};
}

function verifyRiskDecisionDate(
	dataset: AuditReportDataset,
	input: SentenceInput,
	clause: string,
): ReportClaimVerification | undefined {
	const eventId = /paragraph\[risk-([^\]]+)\]/u.exec(input.location)?.[1];
	const accountability = input.location.includes("paragraph[turnover-accountability]");
	if ((!eventId && !accountability) || !clause.includes("决定日期")) return undefined;
	if (/^决定日期[：:]$/u.test(clause)) return undefined; // Legacy label/value clauses are checked separately.
	const events = dataset.riskEvents.filter(
		(event) =>
			event.state === "VERIFIED_VALUE" && (eventId ? event.eventId === eventId : event.type === "accountability"),
	);
	const event = events.length === 1 ? events[0] : undefined;
	const proofs = dataset.evidence.filter(
		(e) => event?.evidenceIds.includes(e.evidenceId) && e.sourceId === "DS-08" && e.sourceRecordId === event.eventId,
	);
	const dates = proofs.filter((e) => e.sourceField === "decisionAt");
	const descriptions = proofs.filter((e) => e.sourceField === "description");
	const types = proofs.filter((e) => e.sourceField === "type");
	const date = dates[0];
	const description = descriptions[0];
	const type = types[0];
	const raw = date?.rawValue ?? "";
	const validDate =
		/^\d{4}-\d{2}-\d{2}$/u.test(raw) &&
		Number.isFinite(Date.parse(raw)) &&
		new Date(raw).toISOString().slice(0, 10) === raw;
	const expected = validDate ? chineseFullDate(raw) : "有效的决定日期原始字段";
	const ids = [...dates, ...descriptions, ...types].map((e) => e.evidenceId);
	const actual = clause.replace(/[\s，；。]+$/gu, "");
	const matches = [`决定日期：${expected}`, `决定日期为${expected}`, `该事项的决定日期为${expected}`].includes(actual);
	const valid = Boolean(
		event &&
			dates.length === 1 &&
			descriptions.length === 1 &&
			types.length === 1 &&
			validDate &&
			date &&
			description &&
			type &&
			date.dataVersion &&
			date.normalizedValue === expected &&
			description.rawValue === event.description &&
			description.normalizedValue === event.description &&
			type.normalizedValue === event.type &&
			type.rawValue.toLowerCase().replace(/_/gu, "-") === event.type &&
			[description, type].every((e) => e.dataVersion === date.dataVersion && e.asOf === date.asOf) &&
			ids.every((id) => input.evidenceIds.includes(id)) &&
			matches,
	);
	return {
		claimId: `risk-decision-date@${input.location}`,
		claimType: "source-field",
		claimText: "本事项决定日期（不等同发生日期或整改日期）",
		expectedValue: expected,
		actualValue: clause,
		value: valid ? 1 : 0,
		reason: valid
			? "已核对本事项同版本的日期、原始描述、类别及段落引用"
			: "决定日期表述、事项归属、版本或字段依据不一致",
		evidence: evidenceReferences(dataset, ids),
	};
}

export function scoreStrictReportClaims(
	dataset: AuditReportDataset,
	draft: ReportDraft,
	historicalReview?: unknown,
): StrictClaimScore {
	const candidates = claimCandidates(dataset);
	const dutyProofs = dataset.evidence.filter(
		(e) =>
			e.sourceId === "DS-03" &&
			e.sourceField === "summary" &&
			e.fileLocation?.startsWith("database:audit_subject_evaluation/"),
	);
	const evidenceSet = new Set(dataset.evidence.map((item) => item.evidenceId));
	const sentences: ReportSentenceVerification[] = [];
	for (const [sentenceIndex, input] of paragraphInputs(draft).entries()) {
		if (input.location.includes("paragraph[regular-overview]") && /^营业部于.*成立/u.test(input.text)) {
			const claim = verifyEstablishmentSentence(dataset, input);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		const historicalClaim = verifyHistoricalJudgment(dataset, input, historicalReview);
		if (historicalClaim) {
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: historicalClaim.value,
				claims: [historicalClaim],
				unsupportedTokens: [],
				reason: historicalClaim.reason,
			});
			continue;
		}
		if (
			/paragraph\[(?:regular-previous-rectification|turnover-historical-findings)\]/u.test(input.location) &&
			input.text.includes("问题主要包括：")
		) {
			const claim = verifyHistoricalInventory(dataset, input);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		if (input.cell) {
			const claim = verifyMetricCell(dataset, input);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		if (input.location.includes("paragraph[risk-none]")) {
			const labels = [
				["security-incident", "重大信息安全事故"],
				["major-emergency", "重大突发事件"],
				["lawsuit", "未决诉讼"],
				["complaint", "未了结客户投诉"],
			] as const;
			const names: string[] = [];
			const ids: string[] = [];
			let valid = true;
			for (const [type, label] of labels) {
				const rows = dataset.riskEvents.filter((event) => event.type === type && event.state === "VERIFIED_NONE");
				if (rows.length === 0) continue;
				const row = rows[0]!;
				if (
					rows.length !== 1 ||
					(row.absenceScope !== undefined &&
						row.absenceScope !== "all" &&
						(row.absenceScope !== "unresolved-during-period" || !["lawsuit", "complaint"].includes(type)))
				)
					valid = false;
				names.push(label);
				const fields: EvidenceRecord[] = [];
				for (const [field, value] of [
					["type", type],
					["state", "VERIFIED_NONE"],
					...(row.absenceScope === undefined ? [] : [["scope", row.absenceScope]]),
				]) {
					const proofs = dataset.evidence.filter(
						(e) =>
							row.evidenceIds.includes(e.evidenceId) &&
							e.sourceId === "DS-08" &&
							(e.sourceField === `${type}.${field}` || e.sourceField === field),
					);
					const proof = proofs[0];
					if (
						proofs.length !== 1 ||
						!proof ||
						proof.rawValue !== value ||
						proof.normalizedValue !== value ||
						proof.asOf !== dataset.task.auditEnd ||
						!proof.sourceRecordId ||
						!proof.dataVersion ||
						!input.evidenceIds.includes(proof.evidenceId)
					)
						valid = false;
					fields.push(...proofs);
				}
				if (
					new Set(fields.map((e) => e.sourceRecordId)).size !== 1 ||
					new Set(fields.map((e) => e.dataVersion)).size !== 1
				)
					valid = false;
				ids.push(...fields.map((e) => e.evidenceId));
			}
			const expected = `经向营业部人员询问和检查相关资料，并向公司其他相关职能部门了解，审计期内，营业部未发生${names.join("、")}等事项。`;
			valid = valid && names.length > 0 && input.text === expected;
			const reason = valid ? "无事项类别、声明范围及同版本字段依据一致" : "无事项表述扩大范围、字段依据缺失或不一致";
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: valid ? 1 : 0,
				unsupportedTokens: [],
				reason,
				claims: [
					{
						claimId: `risk-absence-scope@${sentenceIndex + 1}`,
						claimType: "source-field",
						claimText: "审计期间无事项及其范围",
						expectedValue: expected,
						actualValue: input.text,
						value: valid ? 1 : 0,
						reason,
						evidence: evidenceReferences(dataset, ids),
					},
				],
			});
			continue;
		}
		if (/paragraph\[(?:regular|turnover)-operating-analysis\]/u.test(input.location)) {
			const claim = verifyOperatingSentence(dataset, input, candidates);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		if (input.text.includes("首次审计")) {
			const proofs = dataset.evidence.filter((e) => e.sourceId === "DS-03" && e.sourceField === "firstAudit");
			const proof = proofs[0];
			const value =
				proofs.length === 1 &&
				proof?.rawValue === "true" &&
				proof.normalizedValue === "true" &&
				proof.sourceRecordId === dataset.task.projectId &&
				proof.dataVersion &&
				input.evidenceIds.includes(proof.evidenceId) &&
				!dataset.findings.some((f) => f.isHistorical) &&
				!dataset.evidence.some(
					(e) => e.sourceId === "DS-03" && e.sourceField === "previousQueryReturnedRecordCount",
				) &&
				/paragraph\[(?:regular-previous-rectification|turnover-historical-findings)\]/u.test(input.location) &&
				input.text === "本次为首次审计，无前次审计问题整改情况。"
					? 1
					: 0;
			const reason = value
				? "已核对本项目首次审计原始声明；未用空历史列表推断"
				: "首次审计表述、项目声明或历史记录不一致";
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value,
				unsupportedTokens: [],
				reason,
				claims: [
					{
						claimId: `first-audit@${input.location}`,
						claimType: "source-field",
						claimText: "本项目为首次审计",
						expectedValue: "true",
						actualValue: input.text,
						value,
						reason,
						evidence: evidenceReferences(
							dataset,
							proofs.map((e) => e.evidenceId),
						),
					},
				],
			});
			continue;
		}
		if (input.text.includes("尚无已发布的年度考核结果")) {
			const claim = verifyUnpublishedPerformanceSentence(dataset, input);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		if (input.text.includes("前次审计问题台账查询返回")) {
			const proofs = dataset.evidence.filter(
				(e) => e.sourceId === "DS-03" && e.sourceField === "previousQueryReturnedRecordCount",
			);
			const proof = proofs[0];
			const value =
				proofs.length === 1 &&
				proof?.rawValue === "0" &&
				proof.normalizedValue === "0" &&
				proof.sourceRecordId &&
				proof.dataVersion &&
				input.evidenceIds.includes(proof.evidenceId) &&
				!dataset.findings.some((f) => f.isHistorical) &&
				input.text === "前次审计问题台账查询返回0条记录。"
					? 1
					: 0;
			const reason = value
				? "仅核验前次台账查询返回数量，不代表无问题或已整改"
				: "查询数量、历史记录或引用依据不一致";
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value,
				reason,
				unsupportedTokens: [],
				claims: [
					{
						claimId: `previous-query-count@${input.location}`,
						claimType: "derived-calculation",
						claimText: "前次问题台账返回记录数",
						expectedValue: "0",
						actualValue: input.text,
						value,
						reason,
						evidence: evidenceReferences(
							dataset,
							proofs.map((e) => e.evidenceId),
						),
					},
				],
			});
			continue;
		}
		if (
			input.text.includes("绩效考核结果") &&
			/paragraph\[(?:regular-manager-duty|turnover-performance)\]/u.test(input.location)
		) {
			const claim = verifyPerformanceSentence(dataset, input, candidates);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		if (dutyProofs.length && input.location.includes("paragraph[regular-manager-duty]")) {
			const matching = dutyProofs.filter(
				(e) =>
					e.sourceRecordId &&
					e.dataVersion &&
					input.evidenceIds.includes(e.evidenceId) &&
					normalize(e.rawValue).includes(normalize(input.text)) &&
					normalize(e.normalizedValue).includes(normalize(input.text)),
			);
			const value = matching.length ? 1 : 0;
			const reason = value ? "履职事实可在已引用的原始业务摘要逐字定位" : "履职事实与原始摘要不一致或未引用对应依据";
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value,
				unsupportedTokens: [],
				reason,
				claims: [
					{
						claimId: `duty-source@${input.location}`,
						claimType: "source-narrative",
						claimText: input.text,
						expectedValue: matching.map((e) => e.rawValue).join(""),
						actualValue: input.text,
						value,
						reason,
						evidence: evidenceReferences(
							dataset,
							matching.map((e) => e.evidenceId),
						),
					},
				],
			});
			continue;
		}
		if (/paragraph\[(?:(?:regular|turnover)-internal-control|turnover-clean-practice)\]/u.test(input.location)) {
			const claim = verifyControlSentence(dataset, input);
			sentences.push({
				sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
				location: input.location,
				text: input.text,
				value: claim.value,
				claims: [claim],
				unsupportedTokens: [],
				reason: claim.reason,
			});
			continue;
		}
		const claims: ReportClaimVerification[] = [];
		const unsupportedTokens: string[] = [];
		if (
			(input.location.includes("turnover-historical-findings") ||
				input.location.includes("turnover-conclusion") ||
				input.location.includes("regular-previous-rectification")) &&
			/(?:未.*整改|已整改|未再发现|仍然存在)/u.test(input.text)
		) {
			claims.push({
				claimId: `historical-independent-review@${sentenceIndex + 1}`,
				claimType: "unsupported-factual-statement",
				claimText: input.text,
				expectedValue: "独立标注或独立语义评估结果",
				actualValue: input.text,
				value: 0,
				reason: "原文可追溯不等于历史匹配判断正确；不得复用生成器结论作为评分答案",
				evidence: evidenceReferences(dataset, input.evidenceIds),
			});
		}
		const sentenceNormative =
			/(?:应当|应认真|建议|整改要求|将持续|需进一步|仍需|应进一步|应加强|应勤勉|应针对)/u.test(input.text);
		for (const [clauseIndex, clause] of splitClauses(input.text).entries()) {
			const normalizedClause = normalize(clause);
			const riskDate = verifyRiskDecisionDate(dataset, input, clause);
			if (riskDate) {
				claims.push(riskDate);
				continue;
			}
			if (input.location.includes("paragraph[regular-overview]") && clause.includes("证券经纪人")) {
				const proofs = dataset.evidence.filter(
					(e) => dataset.personnel.evidenceIds.includes(e.evidenceId) && e.sourceField === "brokerCount",
				);
				const count = dataset.personnel.brokerCount;
				const proof = proofs[0];
				const valid =
					count !== undefined &&
					Number.isSafeInteger(count) &&
					count >= 0 &&
					normalizedClause === normalize(`证券经纪人${count}名`) &&
					proofs.length === 1 &&
					proof !== undefined &&
					proof.rawValue === String(count) &&
					proof.normalizedValue === String(count) &&
					proof.asOf === dataset.task.auditEnd &&
					Boolean(proof.sourceRecordId && proof.dataVersion) &&
					input.evidenceIds.includes(proof.evidenceId);
				claims.push({
					claimId: `personnel-broker-source@${sentenceIndex + 1}.${clauseIndex + 1}`,
					claimType: valid ? "source-field" : "unsupported-factual-statement",
					claimText: "期末证券经纪人人数",
					expectedValue: count === undefined ? "未知，不生成数量或无人员结论" : String(count),
					actualValue: clause,
					value: valid ? 1 : 0,
					reason: valid ? "经纪人数与期末原始字段及段落依据一致" : "经纪人数未知、表述或对应期末依据不一致",
					evidence: evidenceReferences(
						dataset,
						proofs.map((e) => e.evidenceId),
					),
				});
				continue;
			}
			const matched = candidates.filter((candidate) => {
				if (candidate.key.startsWith("finding.") && candidate.key.endsWith(".issueCount")) {
					const findingId = candidate.key.slice("finding.".length, -".issueCount".length);
					return (
						input.location.includes(`paragraph[finding-${findingId}-`) &&
						candidate.variants.some((variant) => normalize(variant) === normalizedClause) &&
						candidate.evidenceIds.length > 0 &&
						candidate.evidenceIds.every((id) => input.evidenceIds.includes(id))
					);
				}
				const textMatches = candidate.variants.some((variant) => {
					const normalizedVariant = normalize(variant);
					if (candidate.claimType === "source-narrative")
						return (
							normalizedVariant.length >= 4 &&
							!/^(?:审计期内|审计发现|其中|根据公司规定)$/u.test(normalizedVariant) &&
							normalizedClause === normalizedVariant
						);
					return normalizedVariant.length >= 2 && normalizedClause.includes(normalizedVariant);
				});
				if (!textMatches) return false;
				if (candidate.key === "aml.finding-presence") return true;
				return (
					input.evidenceIds.length === 0 ||
					candidate.evidenceIds.length === 0 ||
					candidate.evidenceIds.some((id) => input.evidenceIds.includes(id))
				);
			});
			const directEvidence = matched.length === 0 ? directEvidenceForClause(dataset, clause, input.evidenceIds) : [];
			const plainClause = clause.replace(/[，；：。]/gu, "");
			const fixedTemplateClause =
				clause === "备注：" ||
				input.location.includes("aml-overview") ||
				input.location.includes("aml-domain-") ||
				input.location.includes("turnover-duty-intro") ||
				clause.includes("上述排名剔除已撤销营业部") ||
				clause.includes("检查内容包括内控机制建设") ||
				(input.location.includes("paragraph[attachment-aml-introduction]") &&
					plainClause ===
						"检查内容主要包括内控机制建设、客户身份识别、客户风险分类管理、大额交易和可疑交易报告、客户身份资料和交易记录保存、培训与宣传等方面") ||
				clause.endsWith("主要职责履行情况如下：") ||
				/^(?:按照审计工作安排|现出具报告如下|以下简称|经审计)$/u.test(plainClause) ||
				/^(?:审计期内|截至审计期末|从指标排名情况来看|从本次审计情况看|主要包括以下问题)$/u.test(plainClause) ||
				/同志任职期内$/u.test(plainClause) ||
				/^公司对.+绩效考核结果为$/u.test(plainClause) ||
				/^审计组依据.+要求$/u.test(plainClause) ||
				/^营业部按照.+规定$/u.test(plainClause) ||
				/^经向.+了解$/u.test(plainClause);
			const normativeClause =
				sentenceNormative ||
				/(?:应当|应认真|建议|整改要求|将持续|需进一步|仍需|应进一步|应加强|应勤勉|应针对)/u.test(clause);
			const isFactualClause =
				matched.length > 0 ||
				directEvidence.length > 0 ||
				(!fixedTemplateClause && !normativeClause && input.evidenceIds.length > 0 && factualSignal.test(clause));
			if (!isFactualClause) continue;
			for (const [claimIndex, candidate] of matched.entries()) {
				const evidence = evidenceReferences(dataset, candidate.evidenceIds);
				const evidenceExists =
					candidate.evidenceIds.length > 0 &&
					candidate.evidenceIds.every((id) => evidenceSet.has(id)) &&
					(candidate.key !== "aml.finding-presence" ||
						candidate.evidenceIds.every((id) => input.evidenceIds.includes(id)));
				const rawValueMatches =
					!candidate.requireRawValueMatch ||
					evidence.some((item) =>
						candidate.expectedNumber !== undefined
							? Number.isFinite(candidate.expectedNumber) &&
								Boolean(item.rawValue.trim()) &&
								Boolean(item.normalizedValue.trim()) &&
								Number(item.rawValue) === candidate.expectedNumber &&
								Number(item.normalizedValue) === candidate.expectedNumber
							: normalize(item.normalizedValue) === normalize(candidate.expectedValue) ||
								normalize(item.rawValue) === normalize(candidate.expectedValue),
					);
				const value = evidenceExists && rawValueMatches ? 1 : 0;
				claims.push({
					claimId: `${candidate.key}@${sentenceIndex + 1}.${clauseIndex + 1}.${claimIndex + 1}`,
					claimType: candidate.claimType,
					claimText: candidate.claimText,
					expectedValue: candidate.expectedValue,
					actualValue: clause,
					value,
					reason: !evidenceExists
						? "缺少可定位到原系统记录字段的证据"
						: !rawValueMatches
							? "证据原始值与报告主张值不一致"
							: "报告主张与原系统记录字段一致",
					evidence,
				});
			}
			if (directEvidence.length > 0) {
				claims.push({
					claimId: `direct-source@${sentenceIndex + 1}.${clauseIndex + 1}`,
					claimType: "source-narrative",
					claimText: clause,
					expectedValue: clause,
					actualValue: clause,
					value: 1,
					reason: "报告分句可在该段已引用的原系统记录中逐字定位",
					evidence: evidenceReferences(
						dataset,
						directEvidence.map((record) => record.evidenceId),
					),
				});
			}
			if (matched.length === 0 && directEvidence.length === 0) {
				claims.push({
					claimId: `unsupported@${sentenceIndex + 1}.${clauseIndex + 1}`,
					claimType: "unsupported-factual-statement",
					claimText: clause,
					expectedValue: "",
					actualValue: clause,
					value: 0,
					reason: "事实性分句无法映射到原系统记录或经批准的派生规则",
					evidence: [],
				});
			}
			const supportedText = [
				...matched.flatMap((candidate) => candidate.variants),
				...(directEvidence.length > 0 ? [clause] : []),
			].join(" ");
			const supportedNumericTokens = new Set(numericTokens(supportedText));
			const clauseUnsupportedTokens = numericTokens(clause).filter((token) => !supportedNumericTokens.has(token));
			unsupportedTokens.push(...clauseUnsupportedTokens);
			if (clauseUnsupportedTokens.length > 0) {
				claims.push({
					claimId: `unsupported-token@${sentenceIndex + 1}.${clauseIndex + 1}`,
					claimType: "unsupported-factual-statement",
					claimText: `未核验数字或日期：${clauseUnsupportedTokens.join("、")}`,
					expectedValue: "",
					actualValue: clauseUnsupportedTokens.join("、"),
					value: 0,
					reason: "报告中的数字或日期未被任何字段级证据或派生计算覆盖",
					evidence: [],
				});
			}
		}
		if (claims.length === 0) continue;
		const value = claims.every((claim) => claim.value === 1) ? 1 : 0;
		sentences.push({
			sentenceId: `CLAIM-SENT-${String(sentences.length + 1).padStart(4, "0")}`,
			location: input.location,
			text: input.text,
			value,
			claims,
			unsupportedTokens: unique(unsupportedTokens),
			reason: value === 1 ? "句内所有可变主张均通过字段级核验" : "句内存在未核验或不一致主张",
		});
	}

	const allClaims = sentences.flatMap((sentence) => sentence.claims);
	const passedSentenceCount = sentences.filter((sentence) => sentence.value === 1).length;
	const verifiedClaimCount = allClaims.filter((claim) => claim.value === 1).length;
	const tracedClaimCount = allClaims.filter(
		(claim) => claim.evidence.length > 0 && claim.evidence.every((item) => item.sourceRecordId && item.sourceField),
	).length;
	const unsupportedClaimCount = allClaims.filter(
		(claim) => claim.claimType === "unsupported-factual-statement",
	).length;
	const percentage = (numerator: number, denominator: number): number =>
		Number(((numerator / Math.max(denominator, 1)) * 100).toFixed(2));
	return {
		sentenceCount: sentences.length,
		passedSentenceCount,
		sentencePassRate: percentage(passedSentenceCount, sentences.length),
		claimCount: allClaims.length,
		verifiedClaimCount,
		claimVerificationRate: percentage(verifiedClaimCount, allClaims.length),
		sourceTraceRate: percentage(tracedClaimCount, allClaims.length),
		unsupportedClaimCount,
		accepted:
			sentences.length > 0 &&
			passedSentenceCount === sentences.length &&
			verifiedClaimCount === allClaims.length &&
			unsupportedClaimCount === 0,
		sentences,
	};
}
