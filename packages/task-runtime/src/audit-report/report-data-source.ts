import { readFile, stat } from "node:fs/promises";
import * as XLSX from "@e965/xlsx";
import type {
	AmlDomainFact,
	AmlMajorMatterRecord,
	AmlNewAccountRiskRecord,
	AmlPeriodicReviewRecord,
	AmlRegulatoryLetterRecord,
	AmlSummary,
	AppointmentRecord,
	AuditFinding,
	AuditReportDataset,
	AuditReportType,
	DataSourceDefinition,
	EvidenceRecord,
	OperatingMetric,
	OperatingMetricPoint,
	OrganizationSnapshot,
	PerformanceRecord,
	PersonnelSnapshot,
	RectificationRecord,
	ReportTask,
	RiskEvent,
} from "./report-contracts.ts";

type Primitive = string | number | boolean | null;
type FlatRecord = Record<string, Primitive>;

interface ApiMeta {
	sourceSystem: string;
	sheet: string;
	dataVersion: string;
	queriedAt: string;
}

interface ApiEnvelope {
	data: FlatRecord | FlatRecord[] | null;
	meta: ApiMeta;
}

export interface SourceReadTrace {
	sourceId: string;
	kind: "http" | "excel";
	location: string;
	recordCount: number;
	queriedAt: string;
	dataVersion: string;
}

export interface LoadAuditReportDatasetOptions {
	taskId: string;
	reportType: AuditReportType;
	apiBaseUrl: string;
	operatingWorkbookPath: string;
}

export interface LoadedAuditReportDataset {
	dataset: AuditReportDataset;
	sourceReadTrace: readonly SourceReadTrace[];
}

function text(record: FlatRecord, field: string, required = true): string {
	const value = record[field];
	if ((value === null || value === undefined || value === "") && required) {
		throw new Error(`Required source field "${field}" is missing`);
	}
	return value === null || value === undefined ? "" : String(value);
}

function numberValue(record: FlatRecord, field: string): number {
	const value = record[field];
	if (typeof value === "number") return value;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Source field "${field}" is not numeric`);
	return parsed;
}

function booleanValue(record: FlatRecord, field: string): boolean {
	const value = record[field];
	if (typeof value === "boolean") return value;
	if (value === "true" || value === 1) return true;
	if (value === "false" || value === 0) return false;
	throw new Error(`Source field "${field}" is not boolean`);
}

function optionalText(record: FlatRecord, field: string): string | undefined {
	const value = text(record, field, false);
	return value === "" ? undefined : value;
}

function optionalNumber(record: FlatRecord, field: string): number | undefined {
	const value = record[field];
	if (value === null || value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function listValue(record: FlatRecord, field: string): string[] {
	const value = optionalText(record, field);
	return value
		? value
				.split(/[|\n；;]/u)
				.map((item) => item.trim())
				.filter(Boolean)
		: [];
}

function asRecord(value: ApiEnvelope["data"], endpoint: string): FlatRecord {
	if (!value || Array.isArray(value)) throw new Error(`Expected one record from ${endpoint}`);
	return value;
}

function asRecords(value: ApiEnvelope["data"], endpoint: string): FlatRecord[] {
	if (!Array.isArray(value)) throw new Error(`Expected a record list from ${endpoint}`);
	return value;
}

function sheetRecords(workbook: XLSX.WorkBook, sheetName: string): FlatRecord[] {
	const sheet = workbook.Sheets[sheetName];
	if (!sheet) throw new Error(`Operating workbook is missing sheet "${sheetName}"`);
	return XLSX.utils.sheet_to_json<FlatRecord>(sheet, { defval: null, raw: true });
}

function sanitizeEvidencePart(value: string): string {
	return (
		value
			.replace(/[^A-Za-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "record"
	);
}

function sourceDefinitions(records: FlatRecord[]): DataSourceDefinition[] {
	return records.map((record) => ({
		sourceId: text(record, "sourceId"),
		name: text(record, "name"),
		implementationStatus: text(record, "implementationStatus") as DataSourceDefinition["implementationStatus"],
		authority: text(record, "authority") as DataSourceDefinition["authority"],
		requiredCapabilities: text(record, "requiredCapabilities").split("|").filter(Boolean),
		providedCapabilities: text(record, "providedCapabilities").split("|").filter(Boolean),
	}));
}

async function loadOperatingMetrics(
	workbookPath: string,
	organizationCode: string,
	task: ReportTask,
	evidence: EvidenceRecord[],
	trace: SourceReadTrace[],
	allowEmpty: boolean,
): Promise<OperatingMetric[]> {
	const workbook = XLSX.read(await readFile(workbookPath), { type: "buffer", cellDates: true });
	const workbookStat = await stat(workbookPath);
	const queryTime = new Date().toISOString();
	const dataVersion = `xlsx-${Math.trunc(workbookStat.mtimeMs)}`;
	const dictionary = new Map(
		sheetRecords(workbook, "指标字典").map((record) => [text(record, "sourceMetricName"), record]),
	);
	const participants = new Map(
		sheetRecords(workbook, "排名参与家数").map((record) => [
			text(record, "period"),
			numberValue(record, "participants"),
		]),
	);
	const sheet = workbook.Sheets.经营数据;
	if (!sheet) throw new Error('Operating workbook is missing sheet "经营数据"');
	const rows = XLSX.utils.sheet_to_json<Primitive[]>(sheet, {
		header: 1,
		defval: null,
		raw: true,
	});
	const firstRow = rows[0] ?? [];
	const periods: string[] = [];
	let currentPeriod = "";
	for (let column = 3; column < firstRow.length; column += 1) {
		const value = String(firstRow[column] ?? "");
		if (value !== "") currentPeriod = value;
		periods[column] = currentPeriod;
	}
	const metrics: OperatingMetric[] = [];
	for (let row = 2; row < rows.length; row += 1) {
		const sourceRow = rows[row] ?? [];
		const rowOrganizationCode = String(sourceRow[1] ?? "");
		if (rowOrganizationCode !== organizationCode) continue;
		const sourceMetricName = String(sourceRow[2] ?? "");
		const mapping = dictionary.get(sourceMetricName);
		if (!mapping) throw new Error(`Metric dictionary has no mapping for "${sourceMetricName}"`);
		const points: OperatingMetricPoint[] = [];
		for (let column = 3; column < sourceRow.length; column += 2) {
			const period = periods[column];
			const rawValue = sourceRow[column];
			if (!period || rawValue === null || rawValue === "") continue;
			const value = Number(rawValue);
			if (!Number.isFinite(value)) {
				throw new Error(`Operating value at row ${row + 1}, column ${column + 1} is invalid`);
			}
			const rawRank = sourceRow[column + 1];
			const rank = rawRank === null || rawRank === "" ? undefined : Number(rawRank);
			const metricCode = text(mapping, "metricCode");
			const sourceRecordId = `${organizationCode}-${metricCode}-${period}`;
			const evidenceId = `EV-DS04-${sanitizeEvidencePart(sourceRecordId)}-value`;
			evidence.push({
				evidenceId,
				sourceId: "DS-04",
				sourceRecordId,
				sourceField: "value",
				rawValue: String(rawValue),
				normalizedValue: String(value),
				asOf: period,
				queryTime,
				dataVersion,
				fileLocation: `${workbookPath}#经营数据!R${row + 1}C${column + 1}`,
			});
			const pointEvidenceIds = [evidenceId];
			const rankEvidenceId = `EV-DS04-${sanitizeEvidencePart(sourceRecordId)}-rank`;
			evidence.push({
				evidenceId: rankEvidenceId,
				sourceId: "DS-04",
				sourceRecordId,
				sourceField: "rank",
				rawValue: rawRank === null || rawRank === "" ? "" : String(rawRank),
				normalizedValue: rank === undefined ? "—" : String(rank),
				asOf: period,
				queryTime,
				dataVersion,
				fileLocation: `${workbookPath}#经营数据!R${row + 1}C${column + 2}`,
			});
			pointEvidenceIds.push(rankEvidenceId);
			const participantCount = participants.get(period);
			if (participantCount !== undefined) {
				const participantEvidenceId = `EV-DS04-${sanitizeEvidencePart(sourceRecordId)}-participants`;
				evidence.push({
					evidenceId: participantEvidenceId,
					sourceId: "DS-04",
					sourceRecordId,
					sourceField: "participants",
					rawValue: String(participantCount),
					normalizedValue: String(participantCount),
					asOf: period,
					queryTime,
					dataVersion,
					fileLocation: `${workbookPath}#排名参与家数`,
				});
				pointEvidenceIds.push(participantEvidenceId);
			}
			points.push({
				period,
				value,
				...(rank === undefined ? {} : { rank, participants: participantCount }),
				evidenceIds: pointEvidenceIds,
			});
		}
		metrics.push({
			metricCode: text(mapping, "metricCode"),
			reportLabel: text(mapping, "reportLabel"),
			unit: text(mapping, "unit") as OperatingMetric["unit"],
			table: text(mapping, "table") as OperatingMetric["table"],
			includeInRanking: booleanValue(mapping, "includeInRanking"),
			points,
		});
	}
	trace.push({
		sourceId: "DS-04",
		kind: "excel",
		location: workbookPath,
		recordCount: metrics.length,
		queriedAt: queryTime,
		dataVersion,
	});
	if (metrics.length === 0 && !allowEmpty) {
		throw new Error(`Operating workbook contains no rows for organization code ${organizationCode}`);
	}
	const periodYear = (period: string): number | undefined => {
		const match = /^(\d{4})年/u.exec(period);
		return match ? Number(match[1]) : undefined;
	};
	const auditStartYear = Number(task.auditStart.slice(0, 4));
	const auditEndYear = Number(task.auditEnd.slice(0, 4));
	const availablePeriods = metrics[0]?.points.map((point) => point.period) ?? [];
	const selectedPeriods =
		task.reportType === "regular"
			? availablePeriods.filter((period) => {
					const year = periodYear(period);
					return year !== undefined && year >= auditStartYear && year <= auditEndYear;
				})
			: task.reportType === "turnover"
				? availablePeriods.slice(-4)
				: [];
	const selectedPeriodSet = new Set(selectedPeriods);
	return metrics.map((metric) => ({
		...metric,
		points: metric.points.filter((point) => selectedPeriodSet.has(point.period)),
	}));
}

export async function loadAuditReportDataset(
	options: LoadAuditReportDatasetOptions,
): Promise<LoadedAuditReportDataset> {
	const trace: SourceReadTrace[] = [];
	const evidence: EvidenceRecord[] = [];

	const get = async (sourceId: string, endpoint: string): Promise<ApiEnvelope> => {
		const response = await fetch(`${options.apiBaseUrl}${endpoint}`);
		const envelope = (await response.json()) as ApiEnvelope;
		const recordCount = Array.isArray(envelope.data) ? envelope.data.length : envelope.data ? 1 : 0;
		trace.push({
			sourceId,
			kind: "http",
			location: `${options.apiBaseUrl}${endpoint}`,
			recordCount,
			queriedAt: envelope.meta.queriedAt,
			dataVersion: envelope.meta.dataVersion,
		});
		if (!response.ok) throw new Error(`Source request failed: ${response.status} ${endpoint}`);
		return envelope;
	};

	const addEvidence = (
		sourceId: string,
		recordId: string,
		sourceField: string,
		rawValue: Primitive,
		meta: ApiMeta,
		location: string,
		asOf: string,
	): string => {
		const evidenceId = `EV-${sourceId}-${sanitizeEvidencePart(recordId)}-${sanitizeEvidencePart(sourceField)}`;
		evidence.push({
			evidenceId,
			sourceId,
			sourceRecordId: recordId,
			sourceField,
			rawValue: String(rawValue ?? ""),
			normalizedValue: String(rawValue ?? ""),
			asOf,
			queryTime: meta.queriedAt,
			dataVersion: meta.dataVersion,
			fileLocation: `${options.apiBaseUrl}${location}`,
		});
		return evidenceId;
	};

	const taskEndpoint = `/api/audit/projects/${encodeURIComponent(options.taskId)}`;
	const taskEnvelope = await get("DS-01", taskEndpoint);
	const taskRecord = asRecord(taskEnvelope.data, taskEndpoint);
	const sourceReportType = text(taskRecord, "reportType") as AuditReportType;
	if (sourceReportType !== options.reportType) {
		throw new Error(`Task report type ${sourceReportType} does not match requested ${options.reportType}`);
	}
	const task: ReportTask = {
		taskId: text(taskRecord, "taskId"),
		projectId: text(taskRecord, "projectId"),
		reportType: sourceReportType,
		organizationId: text(taskRecord, "organizationId"),
		auditStart: text(taskRecord, "auditStart"),
		auditEnd: text(taskRecord, "auditEnd"),
		auditGroupEstablishedMonth: text(taskRecord, "auditGroupEstablishedMonth"),
		reportDate: text(taskRecord, "reportDate"),
		templateId: text(taskRecord, "templateId"),
		templateVersion: text(taskRecord, "templateVersion"),
		closingOrganization: text(taskRecord, "closingOrganization"),
		...(optionalText(taskRecord, "subjectPersonId")
			? { subjectPersonId: optionalText(taskRecord, "subjectPersonId") }
			: {}),
		...(optionalText(taskRecord, "subjectPersonName")
			? { subjectPersonName: optionalText(taskRecord, "subjectPersonName") }
			: {}),
		...(optionalText(taskRecord, "appointmentStart")
			? { appointmentStart: optionalText(taskRecord, "appointmentStart") }
			: {}),
		...(optionalText(taskRecord, "appointmentEnd")
			? { appointmentEnd: optionalText(taskRecord, "appointmentEnd") }
			: {}),
		feedbackCompleted: booleanValue(taskRecord, "feedbackCompleted"),
	};
	for (const field of [
		"projectId",
		"reportType",
		"organizationId",
		"auditStart",
		"auditEnd",
		"auditGroupEstablishedMonth",
		"reportDate",
		"templateId",
		"templateVersion",
		"closingOrganization",
		"subjectPersonId",
		"subjectPersonName",
		"appointmentStart",
		"appointmentEnd",
		"feedbackCompleted",
	] as const) {
		const value = taskRecord[field];
		if (value !== null && value !== undefined && value !== "") {
			addEvidence("DS-01", task.taskId, field, value, taskEnvelope.meta, taskEndpoint, task.auditEnd);
		}
	}

	const organizationEndpoint = `/api/organizations/${encodeURIComponent(task.organizationId)}?asOf=${encodeURIComponent(task.auditEnd)}`;
	const organizationEnvelope = await get("DS-02", organizationEndpoint);
	const organizationRecord = asRecord(organizationEnvelope.data, organizationEndpoint);
	const organizationId = text(organizationRecord, "organizationId");
	const organizationEvidenceIds = [
		"organizationCode",
		"fullName",
		"address",
		"areaSquareMeters",
		"asOf",
		"historyStatement",
	].flatMap((field) => {
		const value = organizationRecord[field];
		return value === null || value === undefined || value === ""
			? []
			: [
					addEvidence(
						"DS-02",
						organizationId,
						field,
						value,
						organizationEnvelope.meta,
						organizationEndpoint,
						text(organizationRecord, "asOf"),
					),
				];
	});
	const organization: OrganizationSnapshot = {
		organizationId,
		organizationCode: text(organizationRecord, "organizationCode"),
		fullName: text(organizationRecord, "fullName"),
		address: text(organizationRecord, "address"),
		areaSquareMeters: numberValue(organizationRecord, "areaSquareMeters"),
		asOf: text(organizationRecord, "asOf"),
		...(optionalText(organizationRecord, "historyStatement")
			? { historyStatement: optionalText(organizationRecord, "historyStatement") }
			: {}),
		evidenceIds: organizationEvidenceIds,
	};

	const personnelEndpoint = `/api/hr/organizations/${encodeURIComponent(task.organizationId)}/snapshot?asOf=${encodeURIComponent(task.auditEnd)}`;
	const personnelEnvelope = await get("DS-06", personnelEndpoint);
	const personnelRecord = asRecord(personnelEnvelope.data, personnelEndpoint);
	const personnelRecordId = `${task.organizationId}-${text(personnelRecord, "asOf")}`;
	const personnelEvidenceIds = ["employeeCount", "brokerCount", "asOf"].map((field) =>
		addEvidence(
			"DS-06",
			personnelRecordId,
			field,
			personnelRecord[field],
			personnelEnvelope.meta,
			personnelEndpoint,
			text(personnelRecord, "asOf"),
		),
	);
	const personnel: PersonnelSnapshot = {
		organizationId: text(personnelRecord, "organizationId"),
		employeeCount: numberValue(personnelRecord, "employeeCount"),
		brokerCount: numberValue(personnelRecord, "brokerCount"),
		asOf: text(personnelRecord, "asOf"),
		evidenceIds: personnelEvidenceIds,
	};

	const appointmentEndpoint = `/api/oa/appointments?${
		task.subjectPersonId
			? `personId=${encodeURIComponent(task.subjectPersonId)}`
			: `organizationId=${encodeURIComponent(task.organizationId)}`
	}`;
	const appointmentEnvelope = await get("DS-05", appointmentEndpoint);
	const appointments: AppointmentRecord[] = asRecords(appointmentEnvelope.data, appointmentEndpoint).map((record) => {
		const documentNumber = text(record, "documentNumber");
		const appointmentEvidenceIds = [
			"personId",
			"personName",
			"title",
			"fullTitle",
			"action",
			"startDate",
			"endDate",
			"issuer",
			"documentTitle",
			"documentNumber",
			"documentDate",
		].flatMap((field) => {
			const value = record[field];
			return value === null || value === undefined || value === ""
				? []
				: [
						addEvidence(
							"DS-05",
							documentNumber,
							field,
							value,
							appointmentEnvelope.meta,
							appointmentEndpoint,
							text(record, "documentDate"),
						),
					];
		});
		return {
			personId: text(record, "personId"),
			personName: text(record, "personName"),
			title: text(record, "title"),
			...(optionalText(record, "fullTitle") ? { fullTitle: optionalText(record, "fullTitle") } : {}),
			action: text(record, "action") as AppointmentRecord["action"],
			startDate: text(record, "startDate"),
			...(optionalText(record, "endDate") ? { endDate: optionalText(record, "endDate") } : {}),
			issuer: text(record, "issuer"),
			documentTitle: text(record, "documentTitle"),
			documentNumber,
			documentDate: text(record, "documentDate"),
			evidenceIds: appointmentEvidenceIds,
		};
	});

	const findingsParams = new URLSearchParams({
		organizationId: task.organizationId,
		projectId: task.projectId,
	});
	if (task.reportType === "aml") findingsParams.set("category", "反洗钱工作");
	const findingsEndpoint = `/api/audit/findings?${findingsParams.toString()}`;
	const findingListEnvelope = await get("DS-03", findingsEndpoint);
	const currentFindingList = asRecords(findingListEnvelope.data, findingsEndpoint);
	const previousProjectEndpoint = `/api/audit/projects/previous?organizationId=${encodeURIComponent(task.organizationId)}&before=${encodeURIComponent(task.auditStart)}`;
	const previousProjectEnvelope =
		task.reportType === "turnover" ? await get("DS-01", previousProjectEndpoint) : undefined;
	const previousProjectRecord =
		previousProjectEnvelope?.data !== null &&
		previousProjectEnvelope?.data !== undefined &&
		!Array.isArray(previousProjectEnvelope.data)
			? previousProjectEnvelope.data
			: undefined;
	const previousProjectId = previousProjectRecord ? text(previousProjectRecord, "projectId") : undefined;
	const previousFindingsEndpoint = previousProjectId
		? `/api/audit/findings?organizationId=${encodeURIComponent(task.organizationId)}&projectId=${encodeURIComponent(previousProjectId)}`
		: undefined;
	const previousFindingEnvelope = previousFindingsEndpoint ? await get("DS-03", previousFindingsEndpoint) : undefined;
	const previousFindingList =
		previousFindingEnvelope && previousFindingsEndpoint
			? asRecords(previousFindingEnvelope.data, previousFindingsEndpoint)
			: [];
	const previousFindingIds = new Set(previousFindingList.map((record) => text(record, "findingId")));
	const findingList = [...currentFindingList, ...previousFindingList];
	const rectificationsEndpoint = `/api/audit/rectifications?organizationId=${encodeURIComponent(task.organizationId)}&projectId=${encodeURIComponent(task.projectId)}`;
	const rectificationEnvelope = await get("DS-03", rectificationsEndpoint);
	const previousRectificationsEndpoint = previousProjectId
		? `/api/audit/rectifications?organizationId=${encodeURIComponent(task.organizationId)}&projectId=${encodeURIComponent(previousProjectId)}`
		: undefined;
	const previousRectificationEnvelope = previousRectificationsEndpoint
		? await get("DS-03", previousRectificationsEndpoint)
		: undefined;
	const rectifications = new Map([
		...asRecords(rectificationEnvelope.data, rectificationsEndpoint).map(
			(record) =>
				[
					text(record, "findingId"),
					{ record, envelope: rectificationEnvelope, endpoint: rectificationsEndpoint },
				] as const,
		),
		...(previousRectificationEnvelope && previousRectificationsEndpoint
			? asRecords(previousRectificationEnvelope.data, previousRectificationsEndpoint).map(
					(record) =>
						[
							text(record, "findingId"),
							{ record, envelope: previousRectificationEnvelope, endpoint: previousRectificationsEndpoint },
						] as const,
				)
			: []),
	]);
	const findings: AuditFinding[] = [];
	for (const listRecord of findingList) {
		const findingId = text(listRecord, "findingId");
		const detailEndpoint = `/api/audit/findings/${encodeURIComponent(findingId)}`;
		const detailEnvelope = await get("DS-03", detailEndpoint);
		const record = asRecord(detailEnvelope.data, detailEndpoint);
		const findingEvidenceIds = [
			"projectId",
			"organizationId",
			"category",
			"subcategory",
			"findingType",
			"severity",
			"title",
			"policyBasis",
			"factText",
			"rawDetail",
			"internalSubitems",
			"responsibility",
			"majorType",
			"majorConfirmed",
			"sourceOrder",
			"issueCount",
			"foundDate",
			"status",
			"isSubjectResponsible",
		].flatMap((field) => {
			const value = record[field];
			return value === null || value === undefined || value === ""
				? []
				: [
						addEvidence(
							"DS-03",
							findingId,
							field,
							value,
							detailEnvelope.meta,
							detailEndpoint,
							text(record, "foundDate"),
						),
					];
		});
		const rectificationSource = rectifications.get(findingId);
		const rectificationRecord = rectificationSource?.record;
		let rectification: RectificationRecord | undefined;
		if (rectificationSource && rectificationRecord) {
			const rectificationId = text(rectificationRecord, "rectificationId");
			const rectificationEvidenceIds = ["status", "requirement", "deadline", "completedAt"].flatMap((field) => {
				const value = rectificationRecord[field];
				return value === null || value === undefined || value === ""
					? []
					: [
							addEvidence(
								"DS-03",
								rectificationId,
								field,
								value,
								rectificationSource.envelope.meta,
								rectificationSource.endpoint,
								optionalText(rectificationRecord, "completedAt") ?? task.auditEnd,
							),
						];
			});
			rectification = {
				rectificationId,
				status: text(rectificationRecord, "status") as RectificationRecord["status"],
				requirement: text(rectificationRecord, "requirement"),
				...(optionalText(rectificationRecord, "deadline")
					? { deadline: optionalText(rectificationRecord, "deadline") }
					: {}),
				...(optionalText(rectificationRecord, "completedAt")
					? { completedAt: optionalText(rectificationRecord, "completedAt") }
					: {}),
				evidenceIds: rectificationEvidenceIds,
			};
		}
		const sourceOrder = optionalNumber(record, "sourceOrder");
		const internalSubitems = listValue(record, "internalSubitems");
		findings.push({
			findingId,
			projectId: text(record, "projectId"),
			organizationId: text(record, "organizationId"),
			category: text(record, "category"),
			subcategory: text(record, "subcategory"),
			findingType: text(record, "findingType"),
			severity: text(record, "severity") as AuditFinding["severity"],
			title: text(record, "title"),
			policyBasis: text(record, "policyBasis"),
			factText: text(record, "factText"),
			...(optionalText(record, "rawDetail") ? { rawDetail: optionalText(record, "rawDetail") } : {}),
			...(internalSubitems.length > 0 ? { internalSubitems } : {}),
			...(optionalText(record, "responsibility")
				? { responsibility: optionalText(record, "responsibility") as AuditFinding["responsibility"] }
				: {}),
			...(optionalText(record, "majorType")
				? { majorType: optionalText(record, "majorType") as AuditFinding["majorType"] }
				: {}),
			...(record.majorConfirmed !== null && record.majorConfirmed !== undefined && record.majorConfirmed !== ""
				? { majorConfirmed: booleanValue(record, "majorConfirmed") }
				: {}),
			...(sourceOrder === undefined ? {} : { sourceOrder }),
			issueCount: numberValue(record, "issueCount"),
			foundDate: text(record, "foundDate"),
			status: text(record, "status") as AuditFinding["status"],
			isHistorical: previousFindingIds.has(findingId),
			isRepeat: false,
			isSubjectResponsible: booleanValue(record, "isSubjectResponsible"),
			evidenceIds: findingEvidenceIds,
			...(rectification ? { rectification } : {}),
		});
	}

	const riskEndpoint = `/api/compliance/risk-events?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const riskEnvelope = await get("DS-08", riskEndpoint);
	const riskEvents: RiskEvent[] = asRecords(riskEnvelope.data, riskEndpoint).map((record) => {
		const eventId = text(record, "eventId");
		const riskEvidenceIds = [
			"type",
			"state",
			"description",
			"regularDescription",
			"turnoverDescription",
			"occurredAt",
		].flatMap((field) => {
			const value = record[field];
			return value === null || value === undefined || value === ""
				? []
				: [
						addEvidence(
							"DS-08",
							eventId,
							field,
							value,
							riskEnvelope.meta,
							riskEndpoint,
							optionalText(record, "occurredAt") ?? task.auditEnd,
						),
					];
		});
		return {
			eventId,
			type: text(record, "type") as RiskEvent["type"],
			state: text(record, "state") as RiskEvent["state"],
			...(optionalText(record, "description") ? { description: optionalText(record, "description") } : {}),
			...(optionalText(record, "regularDescription")
				? { regularDescription: optionalText(record, "regularDescription") }
				: {}),
			...(optionalText(record, "turnoverDescription")
				? { turnoverDescription: optionalText(record, "turnoverDescription") }
				: {}),
			...(optionalText(record, "occurredAt") ? { occurredAt: optionalText(record, "occurredAt") } : {}),
			evidenceIds: riskEvidenceIds,
		};
	});

	const amlDomainEndpoint = `/api/aml/domains?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const amlDomainEnvelope = await get("DS-07", amlDomainEndpoint);
	const amlDomains: AmlDomainFact[] = asRecords(amlDomainEnvelope.data, amlDomainEndpoint).map((record) => {
		const domain = text(record, "domain") as AmlDomainFact["domain"];
		const recordId = `${task.organizationId}-${domain}`;
		const amlDomainEvidenceIds = ["state", "summary"].map((field) =>
			addEvidence("DS-07", recordId, field, record[field], amlDomainEnvelope.meta, amlDomainEndpoint, task.auditEnd),
		);
		return {
			domain,
			state: text(record, "state") as AmlDomainFact["state"],
			summary: text(record, "summary"),
			evidenceIds: amlDomainEvidenceIds,
		};
	});

	const newAccountEndpoint = `/api/aml/risk-classification/new-account?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const newAccountEnvelope = await get("DS-07", newAccountEndpoint);
	const newAccountRiskRecords: AmlNewAccountRiskRecord[] = asRecords(newAccountEnvelope.data, newAccountEndpoint).map(
		(record) => {
			const flowId = text(record, "flowId");
			const recordEvidenceIds = [
				"customerId",
				"relationshipDate",
				"dueDate",
				"completedDate",
				"status",
				"overdue",
				"overdueBusinessDays",
				"sampleCount",
				"exceptionCount",
				"findingIds",
			].flatMap((field) => {
				const value = record[field];
				return value === null || value === undefined || value === ""
					? []
					: [
							addEvidence(
								"DS-07",
								flowId,
								field,
								value,
								newAccountEnvelope.meta,
								newAccountEndpoint,
								task.auditEnd,
							),
						];
			});
			return {
				flowId,
				customerId: text(record, "customerId"),
				relationshipDate: text(record, "relationshipDate"),
				dueDate: text(record, "dueDate"),
				...(optionalText(record, "completedDate") ? { completedDate: optionalText(record, "completedDate") } : {}),
				status: text(record, "status") as AmlNewAccountRiskRecord["status"],
				overdue: booleanValue(record, "overdue"),
				overdueBusinessDays: numberValue(record, "overdueBusinessDays"),
				sampleCount: numberValue(record, "sampleCount"),
				exceptionCount: numberValue(record, "exceptionCount"),
				findingIds: listValue(record, "findingIds"),
				evidenceIds: recordEvidenceIds,
			};
		},
	);

	const periodicReviewEndpoint = `/api/aml/risk-classification/periodic-review?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const periodicReviewEnvelope = await get("DS-07", periodicReviewEndpoint);
	const periodicReviewRecords: AmlPeriodicReviewRecord[] = asRecords(
		periodicReviewEnvelope.data,
		periodicReviewEndpoint,
	).map((record) => {
		const flowId = text(record, "flowId");
		const recordEvidenceIds = [
			"customerId",
			"riskLevel",
			"reviewCycle",
			"receivedDate",
			"dueDate",
			"firstSubmittedDate",
			"returnedDate",
			"resubmittedDate",
			"completedDate",
			"status",
			"overdue",
			"sampleCount",
			"exceptionCount",
			"findingIds",
		].flatMap((field) => {
			const value = record[field];
			return value === null || value === undefined || value === ""
				? []
				: [
						addEvidence(
							"DS-07",
							flowId,
							field,
							value,
							periodicReviewEnvelope.meta,
							periodicReviewEndpoint,
							task.auditEnd,
						),
					];
		});
		return {
			flowId,
			customerId: text(record, "customerId"),
			riskLevel: text(record, "riskLevel"),
			reviewCycle: text(record, "reviewCycle"),
			receivedDate: text(record, "receivedDate"),
			dueDate: text(record, "dueDate"),
			...(optionalText(record, "firstSubmittedDate")
				? { firstSubmittedDate: optionalText(record, "firstSubmittedDate") }
				: {}),
			...(optionalText(record, "returnedDate") ? { returnedDate: optionalText(record, "returnedDate") } : {}),
			...(optionalText(record, "resubmittedDate")
				? { resubmittedDate: optionalText(record, "resubmittedDate") }
				: {}),
			...(optionalText(record, "completedDate") ? { completedDate: optionalText(record, "completedDate") } : {}),
			status: text(record, "status") as AmlPeriodicReviewRecord["status"],
			overdue: booleanValue(record, "overdue"),
			sampleCount: numberValue(record, "sampleCount"),
			exceptionCount: numberValue(record, "exceptionCount"),
			findingIds: listValue(record, "findingIds"),
			evidenceIds: recordEvidenceIds,
		};
	});

	const letterEndpoint = `/api/aml/regulatory-letters?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const letterEnvelope = await get("DS-07", letterEndpoint);
	const regulatoryLetters: AmlRegulatoryLetterRecord[] = asRecords(letterEnvelope.data, letterEndpoint).map(
		(record) => {
			const letterId = text(record, "letterId");
			const recordEvidenceIds = [
				"letterType",
				"issuer",
				"customerId",
				"inScope",
				"receivedDate",
				"dueDate",
				"enteredDate",
				"reviewedDate",
				"overdue",
				"riskAdjustmentStatus",
				"findingIds",
			].flatMap((field) => {
				const value = record[field];
				return value === null || value === undefined || value === ""
					? []
					: [addEvidence("DS-07", letterId, field, value, letterEnvelope.meta, letterEndpoint, task.auditEnd)];
			});
			return {
				letterId,
				letterType: text(record, "letterType"),
				issuer: text(record, "issuer"),
				...(optionalText(record, "customerId") ? { customerId: optionalText(record, "customerId") } : {}),
				inScope: booleanValue(record, "inScope"),
				receivedDate: text(record, "receivedDate"),
				dueDate: text(record, "dueDate"),
				...(optionalText(record, "enteredDate") ? { enteredDate: optionalText(record, "enteredDate") } : {}),
				...(optionalText(record, "reviewedDate") ? { reviewedDate: optionalText(record, "reviewedDate") } : {}),
				overdue: booleanValue(record, "overdue"),
				riskAdjustmentStatus: text(record, "riskAdjustmentStatus"),
				findingIds: listValue(record, "findingIds"),
				evidenceIds: recordEvidenceIds,
			};
		},
	);

	const majorMatterEndpoint = `/api/audit/major-matters?organizationId=${encodeURIComponent(task.organizationId)}&projectId=${encodeURIComponent(task.projectId)}`;
	const majorMatterEnvelope = await get("DS-08", majorMatterEndpoint);
	const majorMatters: AmlMajorMatterRecord[] = asRecords(majorMatterEnvelope.data, majorMatterEndpoint).map(
		(record) => {
			const matterId = text(record, "matterId");
			const recordEvidenceIds = ["matterType", "confirmedMajor", "subject", "fact", "impact"].map((field) =>
				addEvidence(
					"DS-08",
					matterId,
					field,
					record[field],
					majorMatterEnvelope.meta,
					majorMatterEndpoint,
					task.auditEnd,
				),
			);
			return {
				matterId,
				matterType: text(record, "matterType") as AmlMajorMatterRecord["matterType"],
				confirmedMajor: booleanValue(record, "confirmedMajor"),
				subject: text(record, "subject"),
				fact: text(record, "fact"),
				impact: text(record, "impact"),
				evidenceIds: recordEvidenceIds,
			};
		},
	);

	const suspiciousEndpoint = `/api/aml/suspicious-transactions?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const suspiciousEnvelope = await get("DS-07", suspiciousEndpoint);
	const suspiciousRecords = asRecords(suspiciousEnvelope.data, suspiciousEndpoint);
	const suspiciousEvidenceIds = suspiciousRecords.flatMap((record) => {
		const recordId = text(record, "recognitionId");
		return [
			"recognitionId",
			"recognitionResult",
			"recognitionDate",
			"suspiciousType",
			"transactionCount",
			"generalCount",
			"keyCount",
		].flatMap((field) => {
			const value = record[field];
			return value === null || value === undefined || value === ""
				? []
				: [
						addEvidence(
							"DS-07",
							recordId,
							field,
							value,
							suspiciousEnvelope.meta,
							suspiciousEndpoint,
							task.auditEnd,
						),
					];
		});
	});
	const amlSummaryEndpoint = `/api/aml/summary?organizationId=${encodeURIComponent(task.organizationId)}&start=${encodeURIComponent(task.auditStart)}&end=${encodeURIComponent(task.auditEnd)}`;
	const amlSummaryEnvelope = await get("DS-07", amlSummaryEndpoint);
	const amlSummaryRecord = asRecord(amlSummaryEnvelope.data, amlSummaryEndpoint);
	const amlSummaryRecordId = `${task.organizationId}-summary`;
	const amlSummaryEvidenceIds = [
		"suspiciousTransactionCount",
		"suspiciousTransactionType",
		"generalSuspiciousTransactionCount",
		"keySuspiciousTransactionCount",
		"allSuspiciousTransactionsReported",
		"humanApprovedNoProblemBranch",
		"problemQueryComplete",
		"majorMatterQueryComplete",
	].map((field) =>
		addEvidence(
			"DS-07",
			amlSummaryRecordId,
			field,
			amlSummaryRecord[field],
			amlSummaryEnvelope.meta,
			amlSummaryEndpoint,
			task.auditEnd,
		),
	);
	const aml: AmlSummary = {
		domains: amlDomains,
		suspiciousTransactionCount: numberValue(amlSummaryRecord, "suspiciousTransactionCount"),
		suspiciousTransactionType: text(amlSummaryRecord, "suspiciousTransactionType"),
		generalSuspiciousTransactionCount: numberValue(amlSummaryRecord, "generalSuspiciousTransactionCount"),
		keySuspiciousTransactionCount: numberValue(amlSummaryRecord, "keySuspiciousTransactionCount"),
		allSuspiciousTransactionsReported: booleanValue(amlSummaryRecord, "allSuspiciousTransactionsReported"),
		humanApprovedNoProblemBranch: booleanValue(amlSummaryRecord, "humanApprovedNoProblemBranch"),
		problemQueryComplete: booleanValue(amlSummaryRecord, "problemQueryComplete"),
		majorMatterQueryComplete: booleanValue(amlSummaryRecord, "majorMatterQueryComplete"),
		newAccountRiskRecords,
		periodicReviewRecords,
		regulatoryLetters,
		majorMatters,
		evidenceIds: [...amlSummaryEvidenceIds, ...suspiciousEvidenceIds],
	};

	const performance: PerformanceRecord[] = [];
	const performancePersonIds = task.subjectPersonId
		? [task.subjectPersonId]
		: [...new Set(appointments.map((record) => record.personId))];
	for (const personIdFilter of performancePersonIds) {
		const performanceEndpoint = `/api/performance?personId=${encodeURIComponent(personIdFilter)}`;
		const performanceEnvelope = await get("DS-09", performanceEndpoint);
		for (const record of asRecords(performanceEnvelope.data, performanceEndpoint)) {
			const personId = text(record, "personId");
			const year = numberValue(record, "year");
			const recordId = `${personId}-${year}`;
			const performanceEvidenceIds = ["personId", "year", "rating"].map((field) =>
				addEvidence(
					"DS-09",
					recordId,
					field,
					record[field],
					performanceEnvelope.meta,
					performanceEndpoint,
					`${year}-12-31`,
				),
			);
			performance.push({
				personId,
				year,
				rating: text(record, "rating"),
				evidenceIds: performanceEvidenceIds,
			});
		}
	}

	const narrativeEndpoint = `/api/audit/narrative-facts?organizationId=${encodeURIComponent(task.organizationId)}`;
	const narrativeEnvelope = await get("DS-10", narrativeEndpoint);
	const narrative = asRecord(narrativeEnvelope.data, narrativeEndpoint);
	for (const field of [
		"auditProcedures",
		"internalControlSummary",
		"managerDutySummary",
		"previousRectificationSummary",
		"historicalFindingSummary",
		"cleanPracticeSummary",
	] as const) {
		addEvidence(
			"DS-10",
			task.organizationId,
			field,
			narrative[field],
			narrativeEnvelope.meta,
			narrativeEndpoint,
			task.auditEnd,
		);
	}
	const catalogEndpoint = "/api/source-catalog";
	const catalogEnvelope = await get("DS-11", catalogEndpoint);
	const sources = sourceDefinitions(asRecords(catalogEnvelope.data, catalogEndpoint));
	const operatingMetrics = await loadOperatingMetrics(
		options.operatingWorkbookPath,
		organization.organizationCode,
		task,
		evidence,
		trace,
		task.reportType === "aml",
	);

	return {
		dataset: {
			caseId: text(taskRecord, "caseId"),
			description: text(taskRecord, "description"),
			task,
			sources,
			organization,
			personnel,
			appointments,
			operatingMetrics,
			findings,
			riskEvents,
			aml,
			performance,
			manualDecisions: [],
			evidence,
			fixedFacts: {
				auditProcedures: text(narrative, "auditProcedures"),
				internalControlSummary: text(narrative, "internalControlSummary"),
				managerDutySummary: text(narrative, "managerDutySummary"),
				previousRectificationSummary: text(narrative, "previousRectificationSummary"),
				historicalFindingSummary: text(narrative, "historicalFindingSummary"),
				cleanPracticeSummary: text(narrative, "cleanPracticeSummary"),
			},
		},
		sourceReadTrace: trace,
	};
}
