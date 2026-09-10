import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contentText, createModels, type Context } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { SupervisionAnalysisResult } from "../../src/supervision-analysis/contracts.ts";
import { buildSupervisionReportDocument, type SupervisionReportDocument, type SupervisionReportRecords } from "../../src/supervision-analysis/report-document.ts";
import { parseSupervisionTask } from "../../src/supervision-analysis/task.ts";

type JsonObject = Record<string, unknown>;

interface NarrativeTheme {
	title: string;
	analysis: string;
	issueIds: string[];
}

interface NarrativeDraft {
	schemaVersion: "supervision-report-narrative.v2";
	executiveSummary: string;
	regulatoryOverview: string;
	regulatoryIssues: NarrativeTheme[];
	regulatoryRectification: string;
	externalAuditAnalysis: string;
	internalInspectionOverview: string;
	internalInspectionThemes: NarrativeTheme[];
	accountabilityAnalysis: string;
	violationAccountabilityAnalysis: string;
	routineComplianceAnalysis: string;
	routineRiskAnalysis: string;
	litigationAnalysis: string;
}

function parseArgs(argv: string[]): { analysis: string; records: string; output: string; documentOutput: string; model: string } {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || !value) {
			throw new Error(`Invalid argument near ${name ?? "<end>"}`);
		}
		values.set(name, value);
	}
	for (const required of ["--analysis", "--records", "--output"]) {
		if (!values.has(required)) {
			throw new Error(`Missing required argument ${required}`);
		}
	}
	return {
		analysis: resolve(values.get("--analysis")!),
		records: resolve(values.get("--records")!),
		output: resolve(values.get("--output")!),
		documentOutput: resolve(values.get("--document-output") ?? `${values.get("--output")!}.document.json`),
		model: values.get("--model") ?? "deepseek-v4-flash",
	};
}

async function readJson(path: string): Promise<JsonObject> {
	return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

function compactInput(analysis: JsonObject, records: JsonObject): JsonObject {
	const snapshot = analysis.snapshot as JsonObject;
	const relations = analysis.relations as JsonObject[];
	const selectedRecordIds = new Set(
		relations.flatMap((relation) =>
			typeof relation.selectedRecordId === "string" && ["AUTO_CONFIRMED", "HUMAN_CONFIRMED"].includes(String(relation.status)) ? [relation.selectedRecordId] : [],
		),
	);
	const documents = (snapshot.included as JsonObject[]).map((document) => ({
		documentId: document.documentId,
		documentVersionId: document.documentVersionId,
		title: document.title,
		fileDate: document.fileDate,
		organizationIds: document.organizationIds,
		dataOrigin: document.dataOrigin,
		sourceUrl: document.sourceUrl,
	}));
	const issues = (analysis.issues as JsonObject[]).filter((issue) => ["AUTO_CONFIRMED", "HUMAN_CONFIRMED"].includes(String(issue.confirmationStatus))).map((issue) => {
		return {
			issueId: issue.issueId,
			sourceDocumentId: issue.sourceDocumentId,
			sourceDocumentVersionId: issue.sourceDocumentVersionId,
			reportSection: issue.reportSection,
			category: issue.category,
			description: issue.description,
			organizationIds: issue.organizationIds,
			confirmationStatus: issue.confirmationStatus,
			dataOrigin: issue.dataOrigin,
			fieldValues: issue.fieldValues,
			evidenceIds: issue.evidenceIds,
		};
	});
	return {
		task: analysis.task,
		documents,
		issues,
		relations,
		statistics: analysis.statistics,
		readiness: analysis.readiness,
		rectifications: ((records.rectifications as JsonObject[] | undefined) ?? []).filter((record) =>
			selectedRecordIds.has(String(record.recordId)),
		),
		accountabilities: ((records.accountabilities as JsonObject[] | undefined) ?? []).filter((record) =>
			selectedRecordIds.has(String(record.recordId)),
		),
	};
}

function extractJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("DeepSeek response did not contain a JSON object");
	}
	return JSON.parse(trimmed.slice(start, end + 1));
}

function requireText(value: unknown, name: string, minimumLength = 20): string {
	if (typeof value !== "string" || value.trim().length < minimumLength) {
		throw new Error(`DeepSeek field ${name} must be a substantive string`);
	}
	return value.trim();
}

function validateThemes(
	value: unknown,
	name: string,
	allowedIssueIds: Set<string>,
	requiredIssueIds: Set<string>,
): NarrativeTheme[] {
	const minimumThemes = requiredIssueIds.size === 0 ? 0 : 1;
	if (!Array.isArray(value) || value.length < minimumThemes || value.length > 10) {
		throw new Error(`DeepSeek ${name} must contain ${minimumThemes}-10 themes`);
	}
	const covered = new Set<string>();
	const themes = value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`DeepSeek ${name}[${index}] must be an object`);
		}
		const theme = item as JsonObject;
		if (!Array.isArray(theme.issueIds) || theme.issueIds.length === 0) {
			throw new Error(`DeepSeek ${name}[${index}].issueIds must not be empty`);
		}
		const issueIds = theme.issueIds.map((issueId) => {
			if (typeof issueId !== "string" || !allowedIssueIds.has(issueId)) {
				throw new Error(`DeepSeek returned unknown issueId ${String(issueId)}`);
			}
			covered.add(issueId);
			return issueId;
		});
		return {
			title: requireText(theme.title, `${name}[${index}].title`, 4),
			analysis: requireText(theme.analysis, `${name}[${index}].analysis`, 80),
			issueIds,
		};
	});
	for (const issueId of requiredIssueIds) {
		if (!covered.has(issueId)) {
			throw new Error(`DeepSeek ${name} did not cover required issue ${issueId}`);
		}
	}
	return themes;
}

function validateNarrative(
	value: unknown,
	allowedIssueIds: Set<string>,
	requiredOfficialIssueIds: Set<string>,
	requiredInternalIssueIds: Set<string>,
): NarrativeDraft {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("DeepSeek narrative must be an object");
	}
	const object = value as JsonObject;
	return {
		schemaVersion: "supervision-report-narrative.v2",
		executiveSummary: requireText(object.executiveSummary, "executiveSummary", 200),
		regulatoryOverview: requireText(object.regulatoryOverview, "regulatoryOverview", 120),
		regulatoryIssues: validateThemes(
			object.regulatoryIssues,
			"regulatoryIssues",
			allowedIssueIds,
			requiredOfficialIssueIds,
		),
		regulatoryRectification: requireText(object.regulatoryRectification, "regulatoryRectification", 180),
		externalAuditAnalysis: requireText(object.externalAuditAnalysis, "externalAuditAnalysis", 150),
		internalInspectionOverview: requireText(object.internalInspectionOverview, "internalInspectionOverview", 120),
		internalInspectionThemes: validateThemes(
			object.internalInspectionThemes,
			"internalInspectionThemes",
			allowedIssueIds,
			requiredInternalIssueIds,
		),
		accountabilityAnalysis: requireText(object.accountabilityAnalysis, "accountabilityAnalysis", 120),
		violationAccountabilityAnalysis: requireText(
			object.violationAccountabilityAnalysis,
			"violationAccountabilityAnalysis",
			60,
		),
		routineComplianceAnalysis: requireText(object.routineComplianceAnalysis, "routineComplianceAnalysis", 120),
		routineRiskAnalysis: requireText(object.routineRiskAnalysis, "routineRiskAnalysis", 120),
		litigationAnalysis: requireText(object.litigationAnalysis, "litigationAnalysis", 120),
	};
}

export async function generateSupervisionNarrative(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	if (new Set([args.analysis, args.records, args.output, args.documentOutput]).size !== 4) {
		throw new Error("Analysis, records, narrative output and document output paths must be distinct");
	}
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error("DEEPSEEK_API_KEY is not available in the current process");
	}
	const analysis = await readJson(args.analysis);
	if (analysis.schemaVersion !== "supervision-analysis.v1") {
		throw new Error("--analysis must contain schemaVersion=supervision-analysis.v1");
	}
	analysis.task = parseSupervisionTask(analysis.task);
	const records = await readJson(args.records);
	const input = compactInput(analysis, records);
	const citationInstructions = await readFile(new URL("../../specs/supervision-analysis/report-citations.md", import.meta.url), "utf8");
	const writingContext = await readFile(new URL("../../specs/supervision-analysis/writing-context.md", import.meta.url), "utf8");
	const issues = (analysis.issues as JsonObject[]).filter((issue) => ["AUTO_CONFIRMED", "HUMAN_CONFIRMED"].includes(String(issue.confirmationStatus)));
	const allowedIssueIds = new Set(issues.map((issue) => String(issue.issueId)));
	const requiredOfficialIssueIds = new Set(
		issues.filter((issue) => issue.dataOrigin === "official-public").map((issue) => String(issue.issueId)),
	);
	const requiredInternalIssueIds = new Set(
		issues
			.filter((issue) => ["internal.audit", "internal.compliance", "internal.risk"].includes(String(issue.reportSection)))
			.map((issue) => String(issue.issueId)),
	);

	const models = createModels();
	models.setProvider(deepseekProvider());
	const model = models.getModel("deepseek", args.model);
	if (!model) {
		throw new Error(`DeepSeek model ${args.model} is not available`);
	}
	const context: Context = {
		systemPrompt: [
			"你是证券公司内部审计与监督管理报告的资深撰稿人。",
			"只能根据用户提供的JSON撰写，不得使用外部知识，不得虚构未提供的事项、金额、责任人员、风险等级或整改结果。",
			"正文采用严肃、正式、连贯的中文审计报告文风，使用完整段落阐述事实、问题表现、管理影响和整改进展。",
			"正文不得出现系统、本批次、输入资料、数据来源、dataOrigin、模拟测试、业务验收、证据不足、尚缺证据、待业务确认、未形成结论、不能认定等元说明或辩解式措辞。",
			"测试属性由报告封面统一说明，正文应按报告期事项正常撰写，不重复任何测试或资料边界提示。",
			"资料未反映的事项不能断言未发生，也不能编造引用；对应段落仅作中性范围说明，并将来源数组留空供复核。",
			"问题分析应说明控制缺陷可能造成的管理影响，但不得夸大为已发生损失或已造成后果。",
			"整改分析应逐项吸收记录中的措施与状态，并形成总体进度判断，不使用完成率之外的虚构评价。",
			"避免逐字段罗列、口号、空泛建议、AI腔和同义反复。",
			"只输出JSON，不使用Markdown代码块。",
			citationInstructions,
			writingContext,
		].join("\n"),
		messages: [
			{
				role: "user",
				timestamp: Date.now(),
				content: [
					"请生成以下固定结构的JSON，并按逐段来源规则增加 paragraphSources：",
					'{"executiveSummary":"...","regulatoryOverview":"...","regulatoryIssues":[{"title":"...","analysis":"...","issueIds":["..."]}],"regulatoryRectification":"...","externalAuditAnalysis":"...","internalInspectionOverview":"...","internalInspectionThemes":[{"title":"...","analysis":"...","issueIds":["..."]}],"accountabilityAnalysis":"...","violationAccountabilityAnalysis":"...","routineComplianceAnalysis":"...","routineRiskAnalysis":"...","litigationAnalysis":"..."}',
					"要求：regulatoryIssues覆盖全部official-public问题；internalInspectionThemes覆盖internal.audit、internal.compliance、internal.risk问题；每项只引用输入中存在的issueId。executiveSummary控制在300至450字，regulatoryOverview控制在180至280字，regulatoryIssues每项150至230字，regulatoryRectification控制在300至500字，externalAuditAnalysis控制在220至350字，internalInspectionOverview控制在150至240字，internalInspectionThemes每项150至230字，accountabilityAnalysis控制在180至280字，violationAccountabilityAnalysis控制在80至150字，三个日常监督字段各控制在180至280字。所有字段均写成可直接进入正式报告的完整段落。",
					`输入数据：${JSON.stringify(input)}`,
				].join("\n"),
			},
		],
	};
	const auth = await models.getAuth(model);
	if (!auth) {
		throw new Error("DeepSeek authentication could not be resolved");
	}
	let narrative: (NarrativeDraft & { paragraphSources: unknown }) | undefined;
	let document: SupervisionReportDocument | undefined;
	let lastError: unknown;
	for (const attempt of [
		{ temperature: 0.2, reasoning: "high" as const },
		{ temperature: 0, reasoning: "low" as const },
	]) {
		try {
			const response = await models.completeSimple(model, context, {
				temperature: attempt.temperature,
				maxTokens: 12000,
				reasoning: attempt.reasoning,
			});
			const parsed = extractJson(contentText(response.content));
			const draft = validateNarrative(
				parsed,
				allowedIssueIds,
				requiredOfficialIssueIds,
				requiredInternalIssueIds,
			);
			const candidate = { ...draft, paragraphSources: (parsed as JsonObject).paragraphSources };
			document = await buildSupervisionReportDocument({
				analysis: analysis as unknown as SupervisionAnalysisResult,
				narrative: candidate,
				records: records as unknown as SupervisionReportRecords,
			});
			narrative = candidate;
			break;
		} catch (error) {
			lastError = error;
		}
	}
	if (!narrative || !document) throw lastError;
	const output = {
		...narrative,
		generation: {
			provider: "deepseek",
			model: args.model,
			generatedAt: new Date().toISOString(),
			inputSchemaVersion: analysis.schemaVersion,
		},
	};
	await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
	await writeFile(args.documentOutput, `${JSON.stringify(document, null, 2)}\n`, "utf8");
	process.stdout.write(`${JSON.stringify({ output: args.output, documentOutput: args.documentOutput, provider: "deepseek", model: args.model })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await generateSupervisionNarrative(process.argv.slice(2));
}
