import type {
	AuditReportDataset,
	EvidenceRecord,
	OperatingMetric,
	ReportClaimVerification,
	ReportDraft,
	ReportSentenceVerification,
	StrictClaimScore,
} from "./report-contracts.ts";
import { comparePreviousAuditFindings } from "./report-pipeline.ts";

interface SentenceInput {
	location: string;
	text: string;
	evidenceIds: readonly string[];
}

interface ClaimCandidate {
	key: string;
	claimType: Exclude<ReportClaimVerification["claimType"], "unsupported-factual-statement">;
	claimText: string;
	expectedValue: string;
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
	const pushText = (location: string, text: string, evidenceIds: readonly string[]) => {
		for (const [index, sentence] of splitSentences(text).entries()) {
			inputs.push({
				location: `${location}.sentence[${index + 1}]`,
				text: sentence,
				evidenceIds,
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
	if (!metric || metric.points.length < 2) return "待确认";
	const increasing = metric.points.every(
		(point, index, values) => index === 0 || point.value >= (values[index - 1]?.value ?? point.value),
	);
	const decreasing = metric.points.every(
		(point, index, values) => index === 0 || point.value <= (values[index - 1]?.value ?? point.value),
	);
	if (increasing) return "逐年增长";
	if (decreasing) return "总体下降";
	return "有所波动";
}

function evidenceForField(dataset: AuditReportDataset, sourceId: string, recordId: string, field: string): string[] {
	return dataset.evidence
		.filter((item) => item.sourceId === sourceId && item.sourceRecordId === recordId && item.sourceField === field)
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
			variants: unique([
				...variants,
				...variants.flatMap((variant) => splitSentences(variant)),
				...variants.flatMap((variant) => splitSentences(variant).flatMap((sentence) => splitClauses(sentence))),
			]),
			evidenceIds: unique(evidenceIds),
			requireRawValueMatch,
		});
	};

	const taskRecordId = dataset.task.taskId;
	add(
		"task.audit-period",
		"derived-calculation",
		"审计期间",
		`${dataset.task.auditStart}..${dataset.task.auditEnd}`,
		[chineseDateRange(dataset.task.auditStart, dataset.task.auditEnd)],
		[
			...evidenceForField(dataset, "DS-01", taskRecordId, "auditStart"),
			...evidenceForField(dataset, "DS-01", taskRecordId, "auditEnd"),
		],
		false,
	);
	add(
		"task.audit-group-month",
		"source-field",
		"审计组成立月份",
		dataset.task.auditGroupEstablishedMonth,
		[dataset.task.auditGroupEstablishedMonth],
		evidenceForField(dataset, "DS-01", taskRecordId, "auditGroupEstablishedMonth"),
	);
	add(
		"task.report-date",
		"source-field",
		"报告日期",
		dataset.task.reportDate,
		[dataset.task.reportDate],
		evidenceForField(dataset, "DS-01", taskRecordId, "reportDate"),
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
			evidenceForField(dataset, "DS-02", organization.organizationId, field),
		);
	}

	const personnelRecordId = `${organization.organizationId}-${dataset.personnel.asOf}`;
	add(
		"personnel.employeeCount",
		"source-field",
		"正式员工人数",
		dataset.personnel.employeeCount,
		[`正式员工${dataset.personnel.employeeCount}名`],
		evidenceForField(dataset, "DS-06", personnelRecordId, "employeeCount"),
	);
	add(
		"personnel.brokerCount",
		"source-field",
		"证券经纪人数",
		dataset.personnel.brokerCount,
		[`证券经纪人${dataset.personnel.brokerCount}名`],
		evidenceForField(dataset, "DS-06", personnelRecordId, "brokerCount"),
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
				evidenceForField(dataset, "DS-05", recordId, field),
			);
		}
	}

	for (const metric of dataset.operatingMetrics) {
		for (const point of metric.points) {
			const recordId = `${organization.organizationCode}-${metric.metricCode}-${point.period}`;
			add(
				`metric.${metric.metricCode}.${point.period}.value`,
				"source-field",
				`${metric.reportLabel}${point.period}完成数`,
				point.value,
				[
					`${metric.reportLabel}${point.period}完成数${point.value}`,
					`${metric.reportLabel}${point.period}完成数${point.value.toLocaleString("zh-CN", {
						minimumFractionDigits: 2,
						maximumFractionDigits: 2,
						useGrouping: true,
					})}`,
				],
				evidenceForField(dataset, "DS-04", recordId, "value"),
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
				evidenceForField(dataset, "DS-04", recordId, "rank"),
			);
			if (point.participants !== undefined) {
				add(
					`metric.${metric.metricCode}.${point.period}.participants`,
					"source-field",
					`${point.period}参与排名营业部家数`,
					point.participants,
					[`${point.period}：${point.participants}`, `${point.participants}家`, String(point.participants)],
					evidenceForField(dataset, "DS-04", recordId, "participants"),
				);
			}
		}
	}
	for (const code of ["client_assets", "stock_fund_volume"] as const) {
		const metric = dataset.operatingMetrics.find((item) => item.metricCode === code);
		if (!metric) continue;
		const trend = metricTrend(metric);
		add(
			`derived.${code}.trend`,
			"derived-calculation",
			`${metric.reportLabel}趋势`,
			trend,
			[`${metric.reportLabel.replace(/（.*?）/gu, "")}${trend}`],
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
		const displayedLastPeriod = (periods.at(-1) ?? "").replace(/年1[-—]9月/u, "年9月");
		add(
			"derived.operating-period",
			"derived-calculation",
			"经营数据期间",
			periods.join(".."),
			[
				`${periods[0] ?? ""}-${periods.at(-1) ?? ""}主要经营情况`,
				`${periods[0] ?? ""}-${displayedLastPeriod}主要经营情况`,
			],
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
				[
					`${periods[0] ?? ""}-${displayedLastPeriod}，参与排名的营业部年度家数分别为${participantCounts.join("、")}`,
				],
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
		const latestRevenue = dataset.operatingMetrics
			.filter((metric) => revenueCodes.has(metric.metricCode))
			.map((metric) => ({ metric, value: metric.points.at(-1)?.value ?? 0 }))
			.sort((left, right) => right.value - left.value)[0];
		if (latestRevenue) {
			const label = latestRevenue.metric.reportLabel.replace(/^其中：/u, "");
			add(
				"derived.primary-revenue",
				"derived-calculation",
				"主要收入来源",
				label,
				[`以${label}为主要收入来源`],
				latestRevenue.metric.points.flatMap((point) => point.evidenceIds),
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
			bands.includes("中下游") && bands.includes("中游")
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
					[
						"issueCount",
						"问题数量",
						finding.issueCount,
						[
							`${finding.issueCount}项`,
							`${finding.issueCount}笔`,
							`${finding.issueCount}名`,
							`${finding.issueCount}个`,
						],
					],
				] as const);
		for (const [field, label, value, variants] of findingClaims) {
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
		const comparison = comparePreviousAuditFindings(dataset.findings);
		add(
			"previous.comparison.lead",
			"derived-calculation",
			"上一次与本次问题比对",
			"已完成两期问题逐项比对",
			["经与本次审计问题逐项比对"],
			comparison.previousFindings.flatMap((finding) => finding.evidenceIds),
			false,
		);
		for (const { previous, current } of comparison.unrectified) {
			add(
				`previous.${previous.findingId}.unrectified`,
				"derived-calculation",
				`${previous.findingId}未整改判断`,
				"未整改",
				[
					`${previous.title}在本次审计中仍然存在，认定为未整改`,
					`${previous.title}在本次审计中仍然存在`,
					"认定为未整改",
					`其中“${previous.title}”问题在本次审计中仍然存在，未有效整改`,
				],
				[...previous.evidenceIds, ...current.evidenceIds],
				false,
			);
		}
		for (const previous of comparison.rectified) {
			add(
				`previous.${previous.findingId}.rectified`,
				"derived-calculation",
				`${previous.findingId}已整改判断`,
				"已整改",
				[`${previous.title}本次未再发现，认定为已整改`, `${previous.title}本次未再发现`, "认定为已整改"],
				previous.evidenceIds,
				false,
			);
		}
		if (comparison.unrectified.length > 0) {
			add(
				"previous.exception-conclusion",
				"derived-calculation",
				"历次问题较多且存在未有效整改",
				"营业部合规与风险管理水平有待进一步加强",
				["但历次审计发现的问题较多，且个别问题未得到有效整改，营业部合规与风险管理水平有待进一步加强"],
				comparison.unrectified.flatMap(({ previous, current }) => [
					...previous.evidenceIds,
					...current.evidenceIds,
				]),
				false,
			);
		}
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
		const recordId = `${organization.organizationId}-${domain.domain}`;
		add(
			`aml.${domain.domain}.summary`,
			"source-narrative",
			`${domain.domain}反洗钱领域事实`,
			domain.summary,
			[domain.summary],
			evidenceForField(dataset, "DS-07", recordId, "summary"),
		);
	}
	if (dataset.aml) {
		const recordId = `${organization.organizationId}-summary`;
		add(
			"aml.suspiciousTransactionCount",
			"source-field",
			"可疑交易数量",
			dataset.aml.suspiciousTransactionCount,
			[`${dataset.aml.suspiciousTransactionCount}笔`],
			evidenceForField(dataset, "DS-07", recordId, "suspiciousTransactionCount"),
		);
		add(
			"aml.suspiciousTransactionType",
			"source-field",
			"可疑交易类型",
			dataset.aml.suspiciousTransactionType,
			[dataset.aml.suspiciousTransactionType],
			evidenceForField(dataset, "DS-07", recordId, "suspiciousTransactionType"),
		);
		add(
			"aml.suspiciousTransactionGeneralCount",
			"source-field",
			"一般可疑交易数量",
			dataset.aml.generalSuspiciousTransactionCount,
			[`${dataset.aml.generalSuspiciousTransactionCount}笔`],
			dataset.evidence
				.filter((item) => item.sourceId === "DS-07" && item.sourceField === "generalCount")
				.map((item) => item.evidenceId),
		);
		add(
			"aml.suspiciousTransactionKeyCount",
			"source-field",
			"重点可疑交易数量",
			dataset.aml.keySuspiciousTransactionCount,
			[`${dataset.aml.keySuspiciousTransactionCount}笔`],
			dataset.evidence
				.filter((item) => item.sourceId === "DS-07" && item.sourceField === "keyCount")
				.map((item) => item.evidenceId),
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
		const majorEvidence = dataset.aml.majorMatters.flatMap((matter) => matter.evidenceIds);
		add(
			"aml.majorMatter.none",
			"derived-calculation",
			"重大事项查询结果",
			dataset.aml.majorMatters.filter((matter) => matter.confirmedMajor).length,
			[
				"未发现营业部反洗钱工作存在重大或重要内控缺陷",
				`未发现${dataset.organization.fullName}反洗钱工作存在重大违法违规事项或重大内控缺陷`,
			],
			majorEvidence,
			false,
		);
		if (dataset.findings.some((finding) => finding.category === "反洗钱工作")) {
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
		const recordId = `${record.personId}-${record.year}`;
		add(
			`performance.${recordId}.rating`,
			"source-field",
			`${record.year}年度绩效考核结果`,
			record.rating,
			[`${record.year}年度${record.rating}`],
			evidenceForField(dataset, "DS-09", recordId, "rating"),
		);
	}
	if (dataset.performance.length > 0) {
		const sortedPerformance = dataset.performance.slice().sort((left, right) => left.year - right.year);
		add(
			"performance.sequence",
			"derived-calculation",
			"绩效考核结果序列",
			sortedPerformance.map((record) => record.rating).join("、"),
			[
				`${sortedPerformance[0]?.year ?? ""}-${sortedPerformance.at(-1)?.year ?? ""}年度，公司对${dataset.task.subjectPersonName ?? ""}同志绩效考核结果分别为${sortedPerformance.map((record) => record.rating).join("、")}`,
			],
			sortedPerformance.flatMap((record) => record.evidenceIds),
			false,
		);
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
		add(
			`narrative.${field}`,
			"source-narrative",
			`审计叙述事实${field}`,
			value,
			[value],
			evidenceForField(dataset, "DS-10", organization.organizationId, field),
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

export function scoreStrictReportClaims(dataset: AuditReportDataset, draft: ReportDraft): StrictClaimScore {
	const candidates = claimCandidates(dataset);
	const evidenceSet = new Set(dataset.evidence.map((item) => item.evidenceId));
	const sentences: ReportSentenceVerification[] = [];
	for (const [sentenceIndex, input] of paragraphInputs(draft).entries()) {
		const claims: ReportClaimVerification[] = [];
		const unsupportedTokens: string[] = [];
		const sentenceNormative =
			/(?:应当|应认真|建议|整改要求|将持续|需进一步|仍需|应进一步|应加强|应勤勉|应针对)/u.test(input.text);
		for (const [clauseIndex, clause] of splitClauses(input.text).entries()) {
			const normalizedClause = normalize(clause);
			const matched = candidates.filter((candidate) => {
				const textMatches = candidate.variants.some((variant) => {
					const normalizedVariant = normalize(variant);
					return normalizedVariant.length >= 2 && normalizedClause.includes(normalizedVariant);
				});
				if (!textMatches) return false;
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
				input.location.includes("turnover-internal-control") ||
				input.location.includes("turnover-clean-practice") ||
				clause.includes("上述排名剔除已撤销营业部") ||
				clause.includes("检查内容包括内控机制建设") ||
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
					candidate.evidenceIds.length > 0 && candidate.evidenceIds.every((id) => evidenceSet.has(id));
				const rawValueMatches =
					!candidate.requireRawValueMatch ||
					evidence.some(
						(item) =>
							normalize(item.normalizedValue) === normalize(candidate.expectedValue) ||
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
