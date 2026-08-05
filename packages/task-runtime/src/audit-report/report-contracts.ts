export type AuditReportType = "regular" | "turnover" | "aml";

export type ReportValueState =
	| "VERIFIED_VALUE"
	| "VERIFIED_NONE"
	| "USER_CONFIRMED"
	| "MISSING"
	| "CONFLICTED"
	| "NOT_APPLICABLE";

export type SourceImplementationStatus = "ready" | "export-only" | "manual" | "interface-pending";

export interface ReportAccessScope {
	requestId: string;
	tenantId: string;
	subjectId: string;
	allowedOrganizationIds: readonly string[];
	allowedReportTypes: readonly AuditReportType[];
	allowedSourceIds: readonly string[];
}

export interface ReportTask {
	taskId: string;
	projectId: string;
	reportType: AuditReportType;
	organizationId: string;
	auditStart: string;
	auditEnd: string;
	auditGroupEstablishedMonth: string;
	reportDate: string;
	templateId: string;
	templateVersion: string;
	subjectPersonId?: string;
	subjectPersonName?: string;
	appointmentStart?: string;
	appointmentEnd?: string;
	feedbackCompleted: boolean;
}

export interface DataSourceDefinition {
	sourceId: string;
	name: string;
	implementationStatus: SourceImplementationStatus;
	authority: "primary" | "supporting" | "cross-check";
	requiredCapabilities: readonly string[];
	providedCapabilities: readonly string[];
}

export interface EvidenceRecord {
	evidenceId: string;
	sourceId: string;
	sourceRecordId: string;
	sourceField: string;
	rawValue: string;
	normalizedValue: string;
	asOf: string;
	queryTime: string;
	dataVersion: string;
	fileLocation?: string;
}

export interface OrganizationSnapshot {
	organizationId: string;
	organizationCode: string;
	fullName: string;
	address: string;
	areaSquareMeters: number;
	asOf: string;
	historyStatement?: string;
	evidenceIds: readonly string[];
}

export interface PersonnelSnapshot {
	organizationId: string;
	employeeCount: number;
	brokerCount: number;
	asOf: string;
	evidenceIds: readonly string[];
}

export interface AppointmentRecord {
	personId: string;
	personName: string;
	title: string;
	fullTitle?: string;
	action: "appoint" | "remove" | "acting" | "transfer";
	startDate: string;
	endDate?: string;
	issuer: string;
	documentTitle: string;
	documentNumber: string;
	documentDate: string;
	evidenceIds: readonly string[];
}

export interface OperatingMetricPoint {
	period: string;
	value: number;
	rank?: number;
	participants?: number;
	evidenceIds: readonly string[];
}

export interface OperatingMetric {
	metricCode: string;
	reportLabel: string;
	unit: "万元" | "百分制";
	table: "financial" | "performance";
	includeInRanking: boolean;
	points: readonly OperatingMetricPoint[];
}

export interface RectificationRecord {
	rectificationId: string;
	status: "completed" | "in-progress" | "overdue" | "not-started";
	requirement: string;
	deadline?: string;
	completedAt?: string;
	evidenceIds: readonly string[];
}

export interface AuditFinding {
	findingId: string;
	projectId: string;
	organizationId: string;
	category: string;
	subcategory: string;
	findingType: string;
	severity: "一般" | "重要" | "重大";
	title: string;
	policyBasis: string;
	factText: string;
	rawDetail?: string;
	internalSubitems?: readonly string[];
	responsibility?: "直接责任" | "管理责任" | "不涉及";
	majorType?: "重大违法违规" | "重大内控缺陷";
	majorConfirmed?: boolean;
	sourceOrder?: number;
	issueCount: number;
	foundDate: string;
	status: "open" | "rectifying" | "closed";
	isHistorical: boolean;
	isRepeat: boolean;
	isSubjectResponsible: boolean;
	evidenceIds: readonly string[];
	rectification?: RectificationRecord;
}

export interface RiskEvent {
	eventId: string;
	type: "regulatory-letter" | "complaint" | "lawsuit" | "accountability" | "security-incident" | "major-emergency";
	state: Exclude<ReportValueState, "NOT_APPLICABLE">;
	description?: string;
	regularDescription?: string;
	turnoverDescription?: string;
	occurredAt?: string;
	evidenceIds: readonly string[];
}

export interface AmlDomainFact {
	domain:
		| "internal-control"
		| "customer-identification"
		| "risk-classification"
		| "large-suspicious-transactions"
		| "record-retention"
		| "training-publicity";
	state: Exclude<ReportValueState, "NOT_APPLICABLE">;
	summary: string;
	evidenceIds: readonly string[];
}

export interface AmlNewAccountRiskRecord {
	flowId: string;
	customerId: string;
	relationshipDate: string;
	dueDate: string;
	completedDate?: string;
	status: "completed" | "overdue" | "in-progress" | "not-started";
	overdue: boolean;
	overdueBusinessDays: number;
	sampleCount: number;
	exceptionCount: number;
	findingIds: readonly string[];
	evidenceIds: readonly string[];
}

export interface AmlPeriodicReviewRecord {
	flowId: string;
	customerId: string;
	riskLevel: string;
	reviewCycle: string;
	receivedDate: string;
	dueDate: string;
	firstSubmittedDate?: string;
	returnedDate?: string;
	resubmittedDate?: string;
	completedDate?: string;
	status: "completed" | "overdue" | "in-progress" | "not-started";
	overdue: boolean;
	sampleCount: number;
	exceptionCount: number;
	findingIds: readonly string[];
	evidenceIds: readonly string[];
}

export interface AmlRegulatoryLetterRecord {
	letterId: string;
	letterType: string;
	issuer: string;
	customerId?: string;
	inScope: boolean;
	receivedDate: string;
	dueDate: string;
	enteredDate?: string;
	reviewedDate?: string;
	overdue: boolean;
	riskAdjustmentStatus: string;
	findingIds: readonly string[];
	evidenceIds: readonly string[];
}

export interface AmlMajorMatterRecord {
	matterId: string;
	matterType: "重大违法违规" | "重大内控缺陷" | "监管处罚" | "重大风险事项";
	confirmedMajor: boolean;
	subject: string;
	fact: string;
	impact: string;
	evidenceIds: readonly string[];
}

export interface AmlSummary {
	domains: readonly AmlDomainFact[];
	suspiciousTransactionCount: number;
	suspiciousTransactionType: string;
	generalSuspiciousTransactionCount: number;
	keySuspiciousTransactionCount: number;
	allSuspiciousTransactionsReported: boolean;
	humanApprovedNoProblemBranch: boolean;
	problemQueryComplete: boolean;
	majorMatterQueryComplete: boolean;
	newAccountRiskRecords: readonly AmlNewAccountRiskRecord[];
	periodicReviewRecords: readonly AmlPeriodicReviewRecord[];
	regulatoryLetters: readonly AmlRegulatoryLetterRecord[];
	majorMatters: readonly AmlMajorMatterRecord[];
	evidenceIds: readonly string[];
}

export interface PerformanceRecord {
	personId: string;
	year: number;
	rating: string;
	evidenceIds: readonly string[];
}

export interface ManualDecision {
	decisionId: string;
	fieldId: string;
	previousValue: string;
	selectedValue: string;
	confirmedBy: string;
	confirmedAt: string;
	reason: string;
	evidenceIds: readonly string[];
}

export interface AuditReportDataset {
	caseId: string;
	description: string;
	task: ReportTask;
	sources: readonly DataSourceDefinition[];
	organization: OrganizationSnapshot;
	personnel: PersonnelSnapshot;
	appointments: readonly AppointmentRecord[];
	operatingMetrics: readonly OperatingMetric[];
	findings: readonly AuditFinding[];
	riskEvents: readonly RiskEvent[];
	aml?: AmlSummary;
	performance: readonly PerformanceRecord[];
	manualDecisions: readonly ManualDecision[];
	evidence: readonly EvidenceRecord[];
	fixedFacts: {
		auditProcedures: string;
		internalControlSummary: string;
		managerDutySummary: string;
		previousRectificationSummary: string;
		historicalFindingSummary: string;
		cleanPracticeSummary: string;
	};
}

export interface ReadinessItem {
	fieldId: string;
	state: ReportValueState;
	blocking: boolean;
	message: string;
	evidenceIds: readonly string[];
}

export interface DerivedRank {
	metricCode: string;
	period: string;
	rank: number;
	participants: number;
	band: "上游" | "中上游" | "中游" | "中下游" | "下游";
}

export interface ReportFactPack {
	task: ReportTask;
	readiness: readonly ReadinessItem[];
	blockers: readonly string[];
	warnings: readonly string[];
	derivedRanks: readonly DerivedRank[];
	disclosedFindingIds: readonly string[];
	evidenceIds: readonly string[];
	sourceDesignCoverage: number;
	sourceProductionReadiness: number;
}

export interface ReportTable {
	tableId: string;
	title: string;
	unit?: string;
	headers: readonly string[];
	rows: readonly (readonly (string | number)[])[];
	notes?: readonly string[];
	sourceEvidenceIds: readonly string[];
}

export interface ReportParagraph {
	paragraphId: string;
	text: string;
	evidenceIds: readonly string[];
	requiresHumanReview: boolean;
}

export interface ReportSubsection {
	heading: string;
	paragraphs: readonly ReportParagraph[];
	tables?: readonly ReportTable[];
	tablesAfterParagraphCount?: number;
}

export interface ReportSection {
	heading: string;
	paragraphs: readonly ReportParagraph[];
	tables: readonly ReportTable[];
	subsections: readonly ReportSubsection[];
	closingParagraphs?: readonly ReportParagraph[];
}

export interface ReportDraft {
	taskId: string;
	reportType: AuditReportType;
	templateId: string;
	templateVersion: string;
	titleLines: readonly string[];
	addressee?: string;
	introduction: ReportParagraph;
	sections: readonly ReportSection[];
	closingOrganization: string;
	reportDate: string;
	status: "draft" | "needs-input" | "ready-for-review";
	blockers: readonly string[];
	warnings: readonly string[];
	allEvidenceIds: readonly string[];
}

const EvidenceIdsSchema = Type.Array(Type.String());
const ReportParagraphSchema = Type.Object(
	{
		paragraphId: Type.String(),
		text: Type.String(),
		evidenceIds: EvidenceIdsSchema,
		requiresHumanReview: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const ReportTableSchema = Type.Object(
	{
		tableId: Type.String(),
		title: Type.String(),
		unit: Type.Optional(Type.String()),
		headers: Type.Array(Type.String()),
		rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()]))),
		notes: Type.Optional(Type.Array(Type.String())),
		sourceEvidenceIds: EvidenceIdsSchema,
	},
	{ additionalProperties: false },
);
const ReportSubsectionSchema = Type.Object(
	{
		heading: Type.String(),
		paragraphs: Type.Array(ReportParagraphSchema),
		tables: Type.Optional(Type.Array(ReportTableSchema)),
		tablesAfterParagraphCount: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
const ReportSectionSchema = Type.Object(
	{
		heading: Type.String(),
		paragraphs: Type.Array(ReportParagraphSchema),
		tables: Type.Array(ReportTableSchema),
		subsections: Type.Array(ReportSubsectionSchema),
		closingParagraphs: Type.Optional(Type.Array(ReportParagraphSchema)),
	},
	{ additionalProperties: false },
);

export const ReportDraftSchema = Type.Object(
	{
		taskId: Type.String(),
		reportType: Type.Union([Type.Literal("regular"), Type.Literal("turnover"), Type.Literal("aml")]),
		templateId: Type.String(),
		templateVersion: Type.String(),
		titleLines: Type.Array(Type.String()),
		addressee: Type.Optional(Type.String()),
		introduction: ReportParagraphSchema,
		sections: Type.Array(ReportSectionSchema),
		closingOrganization: Type.String(),
		reportDate: Type.String(),
		status: Type.Union([Type.Literal("draft"), Type.Literal("needs-input"), Type.Literal("ready-for-review")]),
		blockers: Type.Array(Type.String()),
		warnings: Type.Array(Type.String()),
		allEvidenceIds: EvidenceIdsSchema,
	},
	{ additionalProperties: false },
);

export interface RubricItemResult {
	id: string;
	dimension: string;
	description: string;
	applicable: boolean;
	value: 0 | 1;
	critical: boolean;
	evaluationMode: "deterministic" | "semantic-heuristic" | "simulated-human";
	reason: string;
}

export interface ClaimEvidenceReference {
	evidenceId: string;
	sourceId: string;
	sourceName: string;
	sourceRecordId: string;
	sourceField: string;
	rawValue: string;
	normalizedValue: string;
	asOf: string;
	dataVersion: string;
}

export interface ReportClaimVerification {
	claimId: string;
	claimType: "source-field" | "derived-calculation" | "source-narrative" | "unsupported-factual-statement";
	claimText: string;
	expectedValue: string;
	actualValue: string;
	value: 0 | 1;
	reason: string;
	evidence: readonly ClaimEvidenceReference[];
}

export interface ReportSentenceVerification {
	sentenceId: string;
	location: string;
	text: string;
	value: 0 | 1;
	claims: readonly ReportClaimVerification[];
	unsupportedTokens: readonly string[];
	reason: string;
}

export interface StrictClaimScore {
	sentenceCount: number;
	passedSentenceCount: number;
	sentencePassRate: number;
	claimCount: number;
	verifiedClaimCount: number;
	claimVerificationRate: number;
	sourceTraceRate: number;
	unsupportedClaimCount: number;
	accepted: boolean;
	sentences: readonly ReportSentenceVerification[];
}

export interface RubricScore {
	caseId: string;
	reportType: AuditReportType;
	applicableCount: number;
	passedCount: number;
	passRate: number;
	criticalFailures: readonly string[];
	accepted: boolean;
	dimensionScores: Readonly<Record<string, number>>;
	items: readonly RubricItemResult[];
	strictClaims: StrictClaimScore;
}

export interface SourceCoverageAssessment {
	reportType: AuditReportType;
	requiredCapabilityCount: number;
	coveredCapabilityCount: number;
	designCoverage: number;
	productionReadiness: number;
	missingCapabilities: readonly string[];
	pendingSources: readonly string[];
}

import { Type } from "typebox";
