import { readFile } from "node:fs/promises";
import type {
	SupervisionAccountabilityRecord,
	SupervisionAnalysisPayload,
	SupervisionIssue,
	SupervisionMaterial,
	SupervisionRectificationRecord,
} from "./contracts.ts";
import type { DfzqPublicFixtureCorpus } from "./fixture-source.ts";

export interface SupervisionOcrPageExport {
	page: number;
	text: string;
}

export interface SupervisionOcrDocumentExport {
	documentId: string;
	documentVersionId: string;
	filename: string;
	title: string;
	pipelineStatus: string;
	pageCount: number;
	blockCount: number;
	chunkCount: number;
	indexedChunkCount: number;
	ocrConfidenceMin: number | null;
	ocrConfidenceAverage: number | null;
	pages: readonly SupervisionOcrPageExport[];
}

export interface SupervisionOcrE2eExport {
	schemaVersion: "supervision-ocr-e2e.v1";
	batchId: string;
	ocrBackend: string;
	ocrModelSource: string;
	embeddingMode: string;
	embeddingModel?: string;
	semanticRetrievalEvaluationAllowed: boolean;
	semanticRetrievalBenchmarkRun?: boolean;
	documents: readonly SupervisionOcrDocumentExport[];
}

const FILENAMES = {
	publicBySourceId: {
		"DFZQ-LIAONING-2025-RANDOM": "2025年现场检查双随机抽取结果公示.pdf",
		"DFZQ-LIAONING-2025-034": "〔2025〕34号-沈阳南八中路营业部警示函.pdf",
	},
} as const;

const ISSUE_ANCHORS: Readonly<Record<string, readonly (readonly string[])[]>> = {
	"DFZQ-LIAONING-2025-RANDOM": [],
	"DFZQ-LIAONING-2025-034": [
		["营销活动方案", "合规审查记录"],
		["电脑", "监控系统"],
		["经纪人薪酬", "交易量", "绩效考核"],
		["金融产品推介服务", "资料"],
	],
};

function compactOcrText(value: string): string {
	return value
		.replace(/\r/gu, "")
		.replace(/[ \t]+/gu, " ")
		.replace(/\n+/gu, "\n")
		.trim();
}

function cleanField(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function issueCategory(value: string): string {
	if (/信息系统|业务日志|权限|电脑|监控系统/u.test(value)) return "系统权限管理";
	if (/合规职责|合规人员|合规检查|合规有效性|营销活动|审核程序|合规审查/u.test(value)) return "制度及内控机制建设";
	if (/薪酬/u.test(value)) return "员工执业管理";
	if (/风险指标|境外子公司|集体讨论|保荐|辅导|勤勉尽责|适当性|股票期权|金融产品推介/u.test(value)) {
		return "业务管理";
	}
	return "其他";
}

function issueTitle(description: string): string {
	return description.length <= 36 ? description : `${description.slice(0, 35)}…`;
}

function findPage(document: SupervisionOcrDocumentExport, anchor: string): SupervisionOcrPageExport {
	const compactAnchor = anchor.replace(/\s+/gu, "");
	const page = document.pages.find((item) => compactOcrText(item.text).replace(/\s+/gu, "").includes(compactAnchor));
	if (!page) throw new Error(`OCR output is missing anchor ${anchor} in ${document.filename}`);
	return page;
}

function normalizedFields(text: string): {
	issues: string[];
	basis?: string;
	measure?: string;
	rectificationRequirement?: string;
} {
	const lines = text.split(/\r?\n/gu).map(cleanField).filter(Boolean);
	const value = (prefix: string) =>
		lines
			.find((line) => line.startsWith(prefix))
			?.slice(prefix.length)
			.trim();
	return {
		issues: lines.flatMap((line) => {
			const match = /^问题\d+[：:](.+)$/u.exec(line);
			return match?.[1] ? [match[1].trim()] : [];
		}),
		basis: value("依据："),
		measure: value("措施："),
		rectificationRequirement: value("整改要求："),
	};
}

function extractPublicIssues(
	corpus: DfzqPublicFixtureCorpus,
	documentsBySourceId: ReadonlyMap<string, SupervisionOcrDocumentExport>,
): SupervisionIssue[] {
	return corpus.documents.flatMap((source) => {
		const document = documentsBySourceId.get(source.sourceId);
		if (!document) throw new Error(`OCR export is missing public source ${source.sourceId}`);
		const page = document.pages[0];
		if (!page) throw new Error(`OCR output has no page for ${source.sourceId}`);
		const ocrText = compactOcrText(page.text).replace(/\s+/gu, "");
		const fields = normalizedFields(source.normalizedText);
		const anchors = ISSUE_ANCHORS[source.sourceId];
		if (!anchors || anchors.length !== fields.issues.length) {
			throw new Error(`issue anchor configuration mismatch for ${source.sourceId}`);
		}
		return fields.issues.map((description, issueIndex) => {
			const missingAnchor = anchors[issueIndex]?.find((anchor) => !ocrText.includes(anchor.replace(/\s+/gu, "")));
			if (missingAnchor) {
				throw new Error(`OCR output is missing issue anchor ${missingAnchor} in ${source.sourceId}`);
			}
			const issueNumber = String(issueIndex + 1);
			return {
				issueId: `ISSUE-${source.sourceId}-${issueNumber}`,
				extractionRuleId: "external-regulatory-letter",
				reportSection: "external.regulatory",
				sourceDocumentId: document.documentId,
				sourceDocumentVersionId: document.documentVersionId,
				sourceType: "regulatory",
				title: issueTitle(description),
				description,
				organizationIds: source.organizationIds,
				responsibleDepartmentIds: [],
				category: issueCategory(description),
				severity: "medium",
				confirmationStatus: "AUTO_CONFIRMED",
				dataOrigin: "official-public",
				sourceUrl: source.sourceUrl,
				requiresRectification: fields.rectificationRequirement !== undefined,
				requiresAccountability: false,
				...(source.documentNumber ? { documentNumber: source.documentNumber } : {}),
				fieldValues: {
					documentTitle: source.title,
					originalSourceId: source.sourceId,
					...(source.documentNumber ? { documentNumber: source.documentNumber } : {}),
					documentDate: source.publishedAt,
					organization: source.organizationIds,
					issueDescription: description,
					evidenceLocation: `OCR第${page.page}页`,
					issuingAuthority: source.publisher,
					...(fields.basis ? { regulatoryBasis: fields.basis } : {}),
					...(fields.measure ? { regulatoryMeasure: fields.measure } : {}),
					...(fields.rectificationRequirement
						? { rectificationRequirement: fields.rectificationRequirement }
						: {}),
				},
				evidenceIds: [`${document.documentVersionId}:p${page.page}:issue-${issueNumber}`],
			} satisfies SupervisionIssue;
		});
	});
}

function material(
	document: SupervisionOcrDocumentExport,
	sourceType: SupervisionMaterial["sourceType"],
	uploadEntry: SupervisionMaterial["uploadEntry"],
	dataOrigin: SupervisionMaterial["dataOrigin"],
	organizationIds: readonly string[],
	sourceUrl?: string,
	fileDate?: string,
): SupervisionMaterial {
	return {
		documentId: document.documentId,
		documentVersionId: document.documentVersionId,
		parseVersion: "mineru-3.4.5",
		indexVersion: "audit-ai-bge-m3-dense-sparse",
		title: document.title,
		sourceType,
		uploadEntry,
		processingStatus: "indexed",
		dataOrigin,
		...(sourceUrl ? { sourceUrl } : {}),
		...(fileDate ? { fileDate } : {}),
		organizationIds,
	};
}

function recognizedRecordPage(document: SupervisionOcrDocumentExport, recordId: string): number {
	return findPage(document, recordId).page;
}

function recognizedRectifications(
	corpus: DfzqPublicFixtureCorpus,
	documentsById: ReadonlyMap<string, SupervisionOcrDocumentExport>,
): SupervisionRectificationRecord[] {
	return corpus.rectifications.map((record) => {
		const target = documentsById.get(record.sourceDocumentId);
		if (!target) throw new Error(`OCR export is missing rectification document ${record.sourceDocumentId}`);
		const page = recognizedRecordPage(target, record.recordId);
		return {
			...record,
			sourceDocumentId: target.documentId,
			evidenceIds: [`${target.documentVersionId}:p${page}:${record.recordId}`],
		};
	});
}

function recognizedAccountabilities(
	corpus: DfzqPublicFixtureCorpus,
	documentsById: ReadonlyMap<string, SupervisionOcrDocumentExport>,
): SupervisionAccountabilityRecord[] {
	return corpus.accountabilities.map((record) => {
		const document = documentsById.get(record.sourceDocumentId);
		if (!document) throw new Error(`OCR export is missing accountability document ${record.sourceDocumentId}`);
		const sourceAnchor = record.referencedIssueIds[0] ?? record.recordId;
		const page = recognizedRecordPage(document, sourceAnchor);
		return {
			...record,
			sourceDocumentId: document.documentId,
			evidenceIds: [`${document.documentVersionId}:p${page}:${record.recordId}`],
		};
	});
}

function recognizedSyntheticIssues(
	corpus: DfzqPublicFixtureCorpus,
	documentsById: ReadonlyMap<string, SupervisionOcrDocumentExport>,
): SupervisionIssue[] {
	return corpus.syntheticIssues.map((issue) => {
		const document = documentsById.get(issue.sourceDocumentId);
		if (!document) throw new Error(`OCR export is missing synthetic issue document ${issue.sourceDocumentId}`);
		const page = findPage(document, issue.issueId).page;
		return {
			...issue,
			sourceDocumentId: document.documentId,
			sourceDocumentVersionId: document.documentVersionId,
			evidenceIds: [`${document.documentVersionId}:p${page}:${issue.issueId}`],
		};
	});
}

function validateOcrExport(corpus: DfzqPublicFixtureCorpus, value: SupervisionOcrE2eExport): void {
	if (value.schemaVersion !== "supervision-ocr-e2e.v1" || value.ocrBackend !== "mineru") {
		throw new Error("unsupported supervision OCR export");
	}
	const expectedDocumentTotal = corpus.documents.length + corpus.syntheticDocuments.length;
	if (value.documents.length !== expectedDocumentTotal) {
		throw new Error(`supervision OCR export must contain ${expectedDocumentTotal} PDFs`);
	}
	for (const document of value.documents) {
		if (document.pipelineStatus !== "INDEXED" || document.indexedChunkCount <= 0) {
			throw new Error(`OCR document is not indexed: ${document.filename}`);
		}
		if (document.pages.length === 0 || document.blockCount === 0) {
			throw new Error(`OCR document has no parsed content: ${document.filename}`);
		}
	}
}

function documentByFilename(exportValue: SupervisionOcrE2eExport, filename: string): SupervisionOcrDocumentExport {
	const document = exportValue.documents.find((item) => item.filename === filename);
	if (!document) throw new Error(`OCR export is missing ${filename}`);
	return document;
}

export function buildDfzqOcrFixturePayload(
	corpus: DfzqPublicFixtureCorpus,
	exportValue: SupervisionOcrE2eExport,
): SupervisionAnalysisPayload {
	validateOcrExport(corpus, exportValue);
	const publicDocumentsBySourceId = new Map(
		Object.entries(FILENAMES.publicBySourceId).map(([sourceId, filename]) => [
			sourceId,
			documentByFilename(exportValue, filename),
		]),
	);
	const syntheticDocumentsById = new Map(
		corpus.syntheticDocuments.map((source) => [source.documentId, documentByFilename(exportValue, source.filename)]),
	);
	const publicIssues = extractPublicIssues(corpus, publicDocumentsBySourceId);
	const syntheticIssues = recognizedSyntheticIssues(corpus, syntheticDocumentsById);
	const issues = [...publicIssues, ...syntheticIssues];
	const rectifications = recognizedRectifications(corpus, syntheticDocumentsById);
	const accountabilities = recognizedAccountabilities(corpus, syntheticDocumentsById);
	return {
		task: {
			taskId: exportValue.batchId,
			analysisStart: "2025-01-01",
			analysisEnd: "2025-12-31",
			organizationId: "东方证券股份有限公司沈阳南八中路证券营业部",
		},
		snapshotAt: "2026-09-02T00:00:00+08:00",
		materials: [
			...corpus.documents.map((source) =>
				material(
					publicDocumentsBySourceId.get(source.sourceId)!,
					"regulatory",
					source.uploadEntry,
					"official-public",
					source.organizationIds,
					source.sourceUrl,
					source.publishedAt,
				),
			),
			...corpus.syntheticDocuments.map((source) =>
				material(
					syntheticDocumentsById.get(source.documentId)!,
					source.sourceType,
					"supervision",
					"synthetic",
					source.organizationIds,
					undefined,
					source.fileDate,
				),
			),
		],
		issues,
		rectifications,
		accountabilities,
		continuousAsCompleted: false,
	};
}

export async function loadSupervisionOcrE2eExport(path: string): Promise<SupervisionOcrE2eExport> {
	return JSON.parse(await readFile(path, "utf8")) as SupervisionOcrE2eExport;
}

export async function loadDfzqOcrFixturePayload(
	corpus: DfzqPublicFixtureCorpus,
	path: string,
): Promise<SupervisionAnalysisPayload> {
	return buildDfzqOcrFixturePayload(corpus, await loadSupervisionOcrE2eExport(path));
}
