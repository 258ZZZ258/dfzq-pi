import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	SupervisionAccountabilityRecord,
	SupervisionAnalysisPayload,
	SupervisionIssue,
	SupervisionMaterial,
	SupervisionRectificationRecord,
	SupervisionUploadEntry,
} from "./contracts.ts";

export interface DfzqPublicFixtureDocument {
	sourceId: string;
	documentVersionId: string;
	title: string;
	documentNumber?: string;
	publishedAt: string;
	publisher: string;
	sourceUrl: string;
	uploadEntry: SupervisionUploadEntry;
	organizationIds: readonly string[];
	normalizedTextSha256: string;
	normalizedText: string;
}

export interface DfzqSyntheticFixtureDocument {
	documentId: string;
	documentVersionId: string;
	filename: string;
	title: string;
	sourceType: SupervisionMaterial["sourceType"];
	fileDate: string;
	organizationIds: readonly string[];
}

export interface DfzqPublicFixtureCorpus {
	datasetId: string;
	datasetVersion: string;
	retrievedAt: string;
	boundary: string;
	documents: readonly DfzqPublicFixtureDocument[];
	syntheticDocuments: readonly DfzqSyntheticFixtureDocument[];
	syntheticIssues: readonly SupervisionIssue[];
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertUnique(values: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
		seen.add(value);
	}
}

function validateCorpus(corpus: DfzqPublicFixtureCorpus): void {
	if (!corpus.datasetId || !corpus.datasetVersion || !corpus.boundary) {
		throw new Error("fixture corpus requires dataset identity and a data-boundary statement");
	}
	assertUnique(
		corpus.documents.map((document) => document.sourceId),
		"public source id",
	);
	assertUnique(
		corpus.documents.map((document) => document.documentVersionId),
		"public document version id",
	);
	assertUnique(
		corpus.syntheticDocuments.map((document) => document.documentId),
		"synthetic document id",
	);
	assertUnique(
		corpus.syntheticDocuments.map((document) => document.filename),
		"synthetic filename",
	);
	for (const document of corpus.documents) {
		const url = new URL(document.sourceUrl);
		if (url.protocol !== "https:" || url.hostname !== "www.csrc.gov.cn") {
			throw new Error(`fixture public source must use an official CSRC HTTPS URL: ${document.sourceId}`);
		}
		if (sha256(document.normalizedText) !== document.normalizedTextSha256) {
			throw new Error(`normalized public source hash mismatch: ${document.sourceId}`);
		}
	}
	for (const record of [...corpus.rectifications, ...corpus.accountabilities]) {
		if (record.dataOrigin !== "synthetic" || !record.description.startsWith("[模拟]")) {
			throw new Error(`fixture follow-up record must be explicitly synthetic: ${record.recordId}`);
		}
	}
	for (const issue of corpus.syntheticIssues) {
		if (issue.dataOrigin !== "synthetic" || !issue.title.includes("模拟")) {
			throw new Error(`fixture synthetic issue must be explicitly marked: ${issue.issueId}`);
		}
		if (!corpus.syntheticDocuments.some((document) => document.documentId === issue.sourceDocumentId)) {
			throw new Error(`fixture synthetic issue references an unknown document: ${issue.issueId}`);
		}
	}
}

export async function loadDfzqPublicFixtureCorpus(path: string): Promise<DfzqPublicFixtureCorpus> {
	const value = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (!isRecord(value) || !Array.isArray(value.documents)) {
		throw new Error("invalid DFZQ public fixture corpus");
	}
	const corpus = value as unknown as DfzqPublicFixtureCorpus;
	validateCorpus(corpus);
	return corpus;
}

function valueAfterPrefix(lines: readonly string[], prefix: string): string | undefined {
	return lines
		.find((line) => line.startsWith(prefix))
		?.slice(prefix.length)
		.trim();
}

function classifyIssue(value: string): string {
	if (/信息系统|业务日志|权限|电脑|监控系统/u.test(value)) return "系统权限管理";
	if (/合规职责|合规人员|合规检查|合规有效性|营销活动|审核程序|合规审查/u.test(value)) return "制度及内控机制建设";
	if (/薪酬/u.test(value)) return "员工执业管理";
	if (/风险指标|境外子公司|集体讨论/u.test(value)) return "业务管理";
	if (/保荐|辅导|勤勉尽责|适当性|股票期权|金融产品推介/u.test(value)) return "业务管理";
	return "其他";
}

function issueTitle(description: string): string {
	return description.length <= 36 ? description : `${description.slice(0, 35)}…`;
}

export function extractIssuesFromDfzqPublicDocuments(
	documents: readonly DfzqPublicFixtureDocument[],
): SupervisionIssue[] {
	return documents.flatMap((document) => {
		const lines = document.normalizedText
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
		const basis = valueAfterPrefix(lines, "依据：");
		const measure = valueAfterPrefix(lines, "措施：");
		const rectificationRequirement = valueAfterPrefix(lines, "整改要求：");
		return lines.flatMap((line, index) => {
			const match = /^问题(\d+)：(.+)$/u.exec(line);
			if (!match) return [];
			const issueNumber = match[1];
			const description = match[2]?.trim();
			if (!issueNumber || !description) return [];
			const evidenceId = `${document.sourceId}:L${index + 1}`;
			return [
				{
					issueId: `ISSUE-${document.sourceId}-${issueNumber}`,
					extractionRuleId: "external-regulatory-letter",
					reportSection: "external.regulatory",
					sourceDocumentId: document.sourceId,
					sourceDocumentVersionId: document.documentVersionId,
					sourceType: "regulatory",
					title: issueTitle(description),
					description,
					organizationIds: document.organizationIds,
					responsibleDepartmentIds: [],
					category: classifyIssue(description),
					severity: "medium",
					confirmationStatus: "AUTO_CONFIRMED",
					dataOrigin: "official-public",
					sourceUrl: document.sourceUrl,
					requiresRectification: rectificationRequirement !== undefined,
					requiresAccountability: false,
					...(document.documentNumber ? { documentNumber: document.documentNumber } : {}),
					fieldValues: {
						documentTitle: document.title,
						...(document.documentNumber ? { documentNumber: document.documentNumber } : {}),
						documentDate: document.publishedAt,
						organization: document.organizationIds,
						issueDescription: description,
						evidenceLocation: `归一化摘要第${index + 1}行`,
						issuingAuthority: document.publisher,
						...(basis ? { regulatoryBasis: basis } : {}),
						...(measure ? { regulatoryMeasure: measure } : {}),
						...(rectificationRequirement ? { rectificationRequirement } : {}),
					},
					evidenceIds: [evidenceId],
				} satisfies SupervisionIssue,
			];
		});
	});
}

function publicMaterial(document: DfzqPublicFixtureDocument): SupervisionMaterial {
	return {
		documentId: document.sourceId,
		documentVersionId: document.documentVersionId,
		parseVersion: "fixture-normalized-v1",
		indexVersion: "fixture-index-v1",
		title: document.title,
		sourceType: "regulatory",
		uploadEntry: document.uploadEntry,
		processingStatus: "indexed",
		dataOrigin: "official-public",
		sourceUrl: document.sourceUrl,
		fileDate: document.publishedAt,
		organizationIds: document.organizationIds,
	};
}

function syntheticMaterial(document: DfzqSyntheticFixtureDocument): SupervisionMaterial {
	return {
		documentId: document.documentId,
		documentVersionId: document.documentVersionId,
		parseVersion: "fixture-synthetic-v1",
		indexVersion: "fixture-index-v1",
		title: document.title,
		sourceType: document.sourceType,
		uploadEntry: "supervision",
		processingStatus: "indexed",
		dataOrigin: "synthetic",
		fileDate: document.fileDate,
		organizationIds: document.organizationIds,
	};
}

export function buildDfzqPublicFixturePayload(corpus: DfzqPublicFixtureCorpus): SupervisionAnalysisPayload {
	const publicIssues = extractIssuesFromDfzqPublicDocuments(corpus.documents);
	const issues = [...publicIssues, ...corpus.syntheticIssues];
	return {
		task: {
			taskId: `FIXTURE-${corpus.datasetVersion}`,
			analysisStart: "2025-01-01",
			analysisEnd: "2025-12-31",
			organizationId: "东方证券股份有限公司沈阳南八中路证券营业部",
		},
		snapshotAt: "2026-09-02T00:00:00+08:00",
		materials: [...corpus.documents.map(publicMaterial), ...corpus.syntheticDocuments.map(syntheticMaterial)],
		issues,
		rectifications: corpus.rectifications,
		accountabilities: corpus.accountabilities,
		continuousAsCompleted: false,
	};
}

export async function loadDfzqPublicFixturePayload(path: string): Promise<SupervisionAnalysisPayload> {
	return buildDfzqPublicFixturePayload(await loadDfzqPublicFixtureCorpus(path));
}
