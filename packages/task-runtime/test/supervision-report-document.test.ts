import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { generateSupervisionNarrative } from "../scripts/supervision-analysis/generate_deepseek_narrative.ts";
import type {
	SupervisionAnalysisResult,
	SupervisionIssue,
	SupervisionMaterial,
} from "../src/supervision-analysis/contracts.ts";
import {
	buildSupervisionReportDocument,
	editSupervisionReportDocument,
	recheckSupervisionReportDocument,
	type SupervisionParagraphSources,
	type SupervisionReportDocument,
	type SupervisionReportRecords,
} from "../src/supervision-analysis/report-document.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelMock = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@earendil-works/pi-ai", () => ({
	contentText: (content: { text: string }[]) => content.map((item) => item.text).join(""),
	createModels: () => ({
		setProvider: () => {},
		getModel: () => ({ id: "test-model" }),
		getAuth: async () => "test-auth",
		completeSimple: modelMock.complete,
	}),
}));
vi.mock("@earendil-works/pi-ai/providers/deepseek", () => ({ deepseekProvider: () => ({}) }));
const fields = [
	"executiveSummary",
	"regulatoryOverview",
	"regulatoryRectification",
	"externalAuditAnalysis",
	"internalInspectionOverview",
	"accountabilityAnalysis",
	"violationAccountabilityAnalysis",
	"routineComplianceAnalysis",
	"routineRiskAnalysis",
	"litigationAnalysis",
];

function fixture() {
	const material = (id: string, sourceType: SupervisionMaterial["sourceType"]): SupervisionMaterial => ({
		documentId: id,
		documentVersionId: `${id}-V1`,
		title: `${id}资料`,
		sourceType,
		parseVersion: "parse-1",
		indexVersion: "index-1",
		uploadEntry: "supervision",
		processingStatus: "indexed",
		organizationIds: ["ORG-1"],
		fileDate: "2026-01-01",
	});
	const issue = (id: string, doc: string, internal = false): SupervisionIssue => ({
		issueId: id,
		sourceDocumentId: doc,
		sourceDocumentVersionId: `${doc}-V1`,
		title: id,
		description: "检查发现问题",
		extractionRuleId: internal ? "internal-audit-inspection" : "external-regulatory-letter",
		reportSection: internal ? "internal.audit" : "external.regulatory",
		sourceType: internal ? "internal-audit" : "regulatory",
		organizationIds: ["ORG-1"],
		responsibleDepartmentIds: [],
		category: "业务管理",
		severity: "medium",
		confirmationStatus: "AUTO_CONFIRMED",
		requiresRectification: true,
		requiresAccountability: !internal,
		evidenceIds: [`${doc}-V1:p1:${id}`],
		fieldValues: {},
	});
	const analysis: SupervisionAnalysisResult = {
		schemaVersion: "supervision-analysis.v1",
		extractionRuleVersion: "2026-08-25.1",
		task: {
			taskId: "TASK-1",
			organizationId: "ORG-1",
			analysisStart: "2026-01-01",
			analysisEnd: "2026-06-30",
		},
		snapshot: {
			taskId: "TASK-1",
			snapshotAt: "2026-07-01T00:00:00Z",
			included: [
				material("REG", "regulatory"),
				material("INT", "internal-audit"),
				material("RECT", "internal-audit"),
				material("ACC", "accountability"),
			],
			excluded: [],
		},
		issues: [issue("I-1", "REG"), issue("I-2", "REG"), issue("I-3", "INT", true)],
		relations: [
			{
				relationId: "REL-R",
				issueId: "I-1",
				relationType: "RECTIFICATION",
				status: "AUTO_CONFIRMED",
				matchMethod: "EXACT_ISSUE_ID",
				matchScore: 1,
				candidateRecordIds: ["R-1"],
				selectedRecordId: "R-1",
				evidenceIds: ["RECT-V1:p1"],
			},
			{
				relationId: "REL-A",
				issueId: "I-1",
				relationType: "ACCOUNTABILITY",
				status: "HUMAN_CONFIRMED",
				matchMethod: "EXACT_ISSUE_ID",
				matchScore: 1,
				candidateRecordIds: ["A-1"],
				selectedRecordId: "A-1",
				evidenceIds: ["ACC-V1:p1"],
			},
		],
		statistics: {
			issueTotal: 3,
			pendingIssueReviewTotal: 0,
			pendingRelationReviewTotal: 0,
			bySourceType: {},
			byCategory: {},
			byOrganization: {},
			rectification: {
				requiredTotal: 1,
				unmatchedTotal: 0,
				coverageRate: 1,
				matchedCompletionRate: 1,
				confirmedTotal: 1,
				completedTotal: 1,
				completionRate: 1,
				byStatus: { COMPLETED: 1 },
			},
			accountability: { confirmedTotal: 1 },
		},
		readiness: { status: "READY", blockers: [], warnings: [] },
		reportOutline: [],
	};
	const records: SupervisionReportRecords = {
		rectifications: [
			{
				recordId: "R-1",
				sourceDocumentId: "RECT",
				referencedIssueIds: ["I-1"],
				referencedDocumentNumbers: [],
				organizationIds: ["ORG-1"],
				responsibleDepartmentIds: [],
				description: "已完成整改",
				status: "COMPLETED",
				evidenceIds: ["RECT-V1:p1"],
			},
		],
		accountabilities: [
			{
				recordId: "A-1",
				sourceDocumentId: "ACC",
				referencedIssueIds: ["I-1"],
				referencedDocumentNumbers: [],
				organizationIds: ["ORG-1"],
				responsibleDepartmentIds: [],
				description: "已问责",
				action: "通报",
				evidenceIds: ["ACC-V1:p1"],
			},
		],
	};
	const sources = (values: Partial<SupervisionParagraphSources> = {}): SupervisionParagraphSources => ({
		documentVersionIds: [],
		issueIds: [],
		rectificationRecordIds: [],
		accountabilityRecordIds: [],
		...values,
	});
	const paragraphSources: Record<string, SupervisionParagraphSources> = Object.fromEntries(
		fields.map((field) => [field, sources()]),
	);
	paragraphSources.executiveSummary = sources({
		issueIds: ["I-1", "I-2", "I-3"],
		rectificationRecordIds: ["R-1"],
		accountabilityRecordIds: ["A-1"],
	});
	paragraphSources.regulatoryOverview = sources({ documentVersionIds: ["REG-V1"] });
	paragraphSources.regulatoryRectification = sources({ issueIds: ["I-1"], rectificationRecordIds: ["R-1"] });
	paragraphSources.accountabilityAnalysis = sources({ accountabilityRecordIds: ["A-1"] });
	paragraphSources["regulatoryIssues.0.analysis"] = sources({
		issueIds: ["I-1", "I-2", "I-1"],
		documentVersionIds: ["REG-V1"],
	});
	paragraphSources["internalInspectionThemes.0.analysis"] = sources({ issueIds: ["I-3"] });
	const narrative: Record<string, unknown> & { paragraphSources: typeof paragraphSources } = {
		schemaVersion: "supervision-report-narrative.v2",
		...Object.fromEntries(fields.map((field) => [field, `${field}的正文。`])),
		regulatoryIssues: [{ title: "监管问题", analysis: "同一监管文件指出两项问题。", issueIds: ["I-1", "I-2"] }],
		internalInspectionThemes: [{ title: "内部问题", analysis: "内部审计发现一项问题。", issueIds: ["I-3"] }],
		paragraphSources,
	};
	return { analysis, records, narrative };
}

describe("supervision paragraph citations", () => {
	it("rechecks edited text using original evidence and retains unsupported conclusions", async () => {
		const original = await buildSupervisionReportDocument(fixture());
		const edited = editSupervisionReportDocument(original, original.contentHash, [
			{ nodeId: "executiveSummary", text: "整改已全部完成" },
		]);
		const evidence = new Map(
			edited.lineage.flatMap((lineage) =>
				lineage.evidenceIds.map(
					(id) =>
						[
							id,
							{
								documentVersionId: id.split(":")[0]!,
								text: "整改尚未全部完成",
							},
						] as const,
				),
			),
		);
		vi.stubEnv("AUDIT_AI_BASE_URL", "http://audit.test");
		vi.stubEnv("AUDIT_AI_INTERNAL_TOKEN", "test");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { claims: { id: string; evidence: string }[] };
				expect(body.claims[0]!.evidence).toContain("尚未");
				return Response.json({
					verdicts: body.claims.map((c) => ({ id: c.id, supported: false, reason: "原文尚未完成" })),
				});
			}),
		);
		try {
			const checked = await recheckSupervisionReportDocument(edited, edited.contentHash, evidence);
			expect(checked.nodes.find((n) => n.nodeId === "executiveSummary")).toMatchObject({
				citationStatus: "RECHECK_REQUIRED",
				citationReviewReason: "原文尚未完成",
				editedByUser: true,
			});
			await expect(recheckSupervisionReportDocument(edited, edited.contentHash, new Map())).rejects.toThrow(
				"evidence",
			);
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});
	it("guards user edits, rejects stale revisions and invalidates citation status", async () => {
		const before = await buildSupervisionReportDocument(fixture());
		const edits = [{ nodeId: "regulatoryOverview", text: "用户调整后的结论" }];
		const after = editSupervisionReportDocument(before, before.contentHash, edits);
		expect(after.structureHash).toBe(before.structureHash);
		expect(after.contentHash).not.toBe(before.contentHash);
		expect(after.citations).toEqual(before.citations);
		expect(after.nodes.find((n) => n.nodeId === edits[0].nodeId)).toMatchObject({
			text: edits[0].text,
			citationStatus: "RECHECK_REQUIRED",
			editedByUser: true,
			requiresHumanReview: true,
		});
		expect(before.nodes.find((n) => n.nodeId === edits[0].nodeId)?.text).not.toBe(edits[0].text);
		expect(() => editSupervisionReportDocument(after, before.contentHash, edits)).toThrow("conflict");
		expect(() => editSupervisionReportDocument(after, after.contentHash, edits, "REGENERATION")).toThrow(
			"user-edited",
		);
		expect(() =>
			editSupervisionReportDocument(before, before.contentHash, [{ nodeId: "title", text: "改标题" }]),
		).toThrow();
		expect(editSupervisionReportDocument(after, after.contentHash, edits).contentHash).toBe(after.contentHash);
		const schema = JSON.parse(
			await readFile(join(packageRoot, "specs/supervision-analysis/report-document.schema.json"), "utf8"),
		) as TSchema;
		expect(Value.Check(schema, after)).toBe(true);
	});
	it.each([true, false])(
		"validates model output before writing narrative and document (complete sources: %s)",
		async (valid) => {
			const temporary = await mkdtemp(join(tmpdir(), "supervision-generation-"));
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.stubEnv("DEEPSEEK_API_KEY", "test-unused-key");
			try {
				const input = fixture();
				input.analysis.task.analysisDescription = "关注权限回收和整改进展，保留其他固定模块。";
				for (const field of fields)
					input.narrative[field] = "检查发现相关控制环节需要完善，整改事项已按要求逐项跟踪。".repeat(12);
				for (const group of ["regulatoryIssues", "internalInspectionThemes"]) {
					for (const theme of input.narrative[group] as { analysis: string }[])
						theme.analysis = "针对检查发现事项，结合原始资料分析相关控制缺陷及整改要求。".repeat(6);
				}
				const response = {
					...input.narrative,
					paragraphSources: valid ? input.narrative.paragraphSources : undefined,
				};
				modelMock.complete.mockReset().mockResolvedValue({ content: [{ text: JSON.stringify(response) }] });
				await writeFile(join(temporary, "analysis.json"), JSON.stringify(input.analysis));
				await writeFile(join(temporary, "records.json"), JSON.stringify(input.records));
				const output = join(temporary, "narrative.json");
				const run = generateSupervisionNarrative([
					"--analysis",
					join(temporary, "analysis.json"),
					"--records",
					join(temporary, "records.json"),
					"--output",
					output,
				]);
				if (valid) {
					await run;
					const narrative = JSON.parse(await readFile(output, "utf8"));
					const document = JSON.parse(
						await readFile(`${output}.document.json`, "utf8"),
					) as SupervisionReportDocument;
					expect(narrative.paragraphSources).toEqual(input.narrative.paragraphSources);
					expect(document.lineage).toHaveLength(12);
					expect(modelMock.complete).toHaveBeenCalledTimes(1);
					const context = modelMock.complete.mock.calls[0]![1] as {
						systemPrompt: string;
						messages: { content: string }[];
					};
					expect(context.systemPrompt).toContain("paragraphSources");
					expect(context.systemPrompt).toContain("固定生成《监督信息汇总分析报告》");
					expect(context.systemPrompt).toContain("分析说明不是事实证据");
					expect(context.messages[0]!.content).toContain(input.analysis.task.analysisDescription);
					expect(document.citations).toHaveLength(4);
					expect(context.messages[0]!.content).toContain('"documentVersionId":"REG-V1"');
				} else {
					await expect(run).rejects.toThrow("paragraphSources");
					expect(modelMock.complete).toHaveBeenCalledTimes(2);
					await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
					await expect(readFile(`${output}.document.json`)).rejects.toMatchObject({ code: "ENOENT" });
				}
			} finally {
				stdout.mockRestore();
				vi.unstubAllEnvs();
				await rm(temporary, { recursive: true, force: true });
			}
		},
	);
	it("exports every prose block, unique document names, exact follow-up sources and the outward schema", async () => {
		const input = fixture();
		const result = await buildSupervisionReportDocument(input);
		const schema = JSON.parse(
			await readFile(join(packageRoot, "specs/supervision-analysis/report-document.schema.json"), "utf8"),
		) as TSchema;
		expect(Value.Check(schema, result), JSON.stringify([...Value.Errors(schema, result)])).toBe(true);
		expect(result.lineage).toHaveLength(12);
		expect(result.nodes.filter((node) => node.textEditable)).toHaveLength(12);
		const theme = result.nodes.find(
			(node) => node.nodeId.startsWith("regulatoryIssues:") && node.nodeType === "paragraph",
		)!;
		expect(theme.citationIds).toEqual(["document:REG-V1"]);
		expect(result.nodes.find((node) => node.nodeId === "regulatoryRectification")?.citationIds).toEqual([
			"document:RECT-V1",
			"document:REG-V1",
		]);
		expect(result.nodes.find((node) => node.nodeId === "accountabilityAnalysis")?.citationIds).toEqual([
			"document:ACC-V1",
		]);
		expect(result.lineage.find((item) => item.nodeId === "regulatoryRectification")?.evidenceIds).toEqual([
			"RECT-V1:p1",
			"REG-V1:p1:I-1",
		]);
		expect(result.citations).toHaveLength(4);
		expect(
			result.citations.every(
				(citation) =>
					Object.keys(citation).sort().join() === "citationId,documentId,documentVersionId,sourceType,title",
			),
		).toBe(true);
		expect(result.nodes.find((node) => node.nodeId === "litigationAnalysis")).toMatchObject({
			citationIds: [],
			citationStatus: "NO_SOURCE",
			requiresHumanReview: true,
		});
		expect(result.nodes.find((node) => node.nodeId === "task-metadata")).toMatchObject({
			textEditable: false,
			citationIds: [],
			text: "被分析单位：ORG-1。分析期间：2026-01-01至2026-06-30。",
		});
	});

	it("keeps IDs and structure stable on text edits while changing the content revision", async () => {
		const input = fixture();
		const before = await buildSupervisionReportDocument(input);
		input.narrative.regulatoryOverview = "用户修改后的正文。";
		const after = await buildSupervisionReportDocument(input);
		expect(after.structureHash).toBe(before.structureHash);
		expect(after.contentHash).not.toBe(before.contentHash);
		expect(after.nodes.map((node) => node.nodeId)).toEqual(before.nodes.map((node) => node.nodeId));
		expect(after.citations).toEqual(before.citations);
	});

	it.each(["missing", "orphan", "theme", "unknown-field"])("rejects %s paragraph-source mappings", async (mode) => {
		const input = fixture();
		if (mode === "missing") delete input.narrative.paragraphSources.regulatoryOverview;
		if (mode === "orphan")
			input.narrative.paragraphSources.unknown = input.narrative.paragraphSources.regulatoryOverview!;
		if (mode === "theme") input.narrative.paragraphSources["regulatoryIssues.0.analysis"]!.issueIds = [];
		if (mode === "unknown-field")
			Object.assign(input.narrative.paragraphSources.regulatoryOverview!, { titles: ["invented"] });
		await expect(buildSupervisionReportDocument(input)).rejects.toThrow();
	});

	it.each(["unknown", "wrong-version", "wrong-document", "other-org", "pending"])(
		"rejects %s issue citations",
		async (mode) => {
			const input = fixture();
			if (mode === "unknown") input.narrative.paragraphSources.executiveSummary!.issueIds.push("UNKNOWN");
			if (mode === "wrong-version") input.analysis.issues[0]!.sourceDocumentVersionId = "REG-V0";
			if (mode === "wrong-document") input.analysis.issues[0]!.sourceDocumentId = "INT";
			if (mode === "other-org") input.analysis.issues[0]!.organizationIds = ["ORG-2"];
			if (mode === "pending") input.analysis.issues[0]!.confirmationStatus = "PENDING_REVIEW";
			await expect(buildSupervisionReportDocument(input)).rejects.toThrow();
		},
	);

	it.each([
		"unknown-document",
		"excluded-document",
		"unknown-record",
		"unconfirmed-record",
		"unmapped-record",
		"ambiguous-version",
	])("rejects %s sources", async (mode) => {
		const input = fixture();
		if (mode === "unknown-document")
			input.narrative.paragraphSources.regulatoryOverview!.documentVersionIds = ["UNKNOWN"];
		if (mode === "excluded-document") input.analysis.snapshot.included[0]!.processingStatus = "disabled";
		if (mode === "unknown-record")
			input.narrative.paragraphSources.regulatoryRectification!.rectificationRecordIds = ["UNKNOWN"];
		if (mode === "unconfirmed-record") input.analysis.relations[0]!.status = "PENDING_REVIEW";
		if (mode === "unmapped-record") input.records.rectifications[0]!.sourceDocumentId = "LEGACY-ID";
		if (mode === "ambiguous-version")
			input.analysis.snapshot.included = [
				...input.analysis.snapshot.included,
				{ ...input.analysis.snapshot.included[2]!, documentVersionId: "RECT-V2" },
			];
		await expect(buildSupervisionReportDocument(input)).rejects.toThrow();
	});

	it.each(["material", "issue", "rectification", "accountability"])(
		"rejects out-of-period %s references",
		async (kind) => {
			const input = fixture();
			if (kind === "material") input.analysis.snapshot.included[0]!.fileDate = "2026-07-01";
			if (kind === "issue") input.analysis.issues[0]!.discoveredDate = "2026-07-01";
			if (kind === "rectification") input.records.rectifications[0]!.asOfDate = "2026-08-31";
			if (kind === "accountability") input.records.accountabilities[0]!.asOfDate = "2026-07-01";
			await expect(buildSupervisionReportDocument(input)).rejects.toThrow(/outside/u);
		},
	);

	it("uses the explicitly referenced record version and rejects a version outside the snapshot", async () => {
		const input = fixture();
		input.analysis.snapshot.included = [
			...input.analysis.snapshot.included,
			{ ...input.analysis.snapshot.included[2]!, documentVersionId: "RECT-V2" },
		];
		input.records.rectifications[0]!.sourceDocumentVersionId = "RECT-V1";
		const result = await buildSupervisionReportDocument(input);
		expect(result.nodes.find((node) => node.nodeId === "regulatoryRectification")?.citationIds).toEqual([
			"document:RECT-V1",
			"document:REG-V1",
		]);
		input.records.rectifications[0]!.sourceDocumentVersionId = "RECT-V0";
		await expect(buildSupervisionReportDocument(input)).rejects.toThrow(/exactly one/u);
	});

	it("does not conflate two materials with the same title", async () => {
		const input = fixture();
		input.analysis.snapshot.included[1]!.title = input.analysis.snapshot.included[0]!.title;
		const result = await buildSupervisionReportDocument(input);
		expect(result.citations.filter((citation) => citation.title === "REG资料")).toHaveLength(2);
	});

	it("exports through the offline CLI without a model and refuses to overwrite files", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "supervision-citations-"));
		try {
			const input = fixture();
			for (const [name, value] of Object.entries(input))
				await writeFile(join(temporary, `${name}.json`), JSON.stringify(value));
			const output = join(temporary, "document.json");
			const args = [
				"--import",
				"tsx",
				"scripts/supervision-analysis/export_report_document.ts",
				"--analysis",
				join(temporary, "analysis.json"),
				"--narrative",
				join(temporary, "narrative.json"),
				"--records",
				join(temporary, "records.json"),
				"--output",
				output,
			];
			execFileSync(process.execPath, args, { cwd: packageRoot, stdio: "pipe" });
			const result = JSON.parse(await readFile(output, "utf8")) as SupervisionReportDocument;
			expect(result.lineage).toHaveLength(12);
			expect(() => execFileSync(process.execPath, args, { cwd: packageRoot, stdio: "pipe" })).toThrow();
			expect(JSON.parse(await readFile(output, "utf8"))).toEqual(result);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 15_000);
});
