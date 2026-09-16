import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import { resolveSpecPromptPaths } from "../src/spec/resolve-prompt-paths.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import {
	associateSupervisionRecords,
	buildSupervisionAnalysisResult,
	buildSupervisionRetrievalScope,
	buildSupervisionStatistics,
	createMaterialSnapshot,
	getSupervisionExtractionRules,
	SUPERVISION_EXTRACTION_RULE_VERSION,
	type SupervisionIssue,
	type SupervisionMaterial,
	type SupervisionRectificationRecord,
	type SupervisionTaskDescriptor,
	scopeSupervisionAnalysisPayload,
} from "../src/supervision-analysis/index.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import {
	createSupervisionAnalysisToolset,
	parseSupervisionAnalysisPayload,
} from "../src/toolsets/supervision-analysis.ts";
import { createFauxHarness, fauxAssistantMessage, fauxToolCall } from "./helpers/faux.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://unused.test",
	apiKeyEnv: "UNUSED_TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux-model",
			contextWindow: 128000,
			maxTokens: 8192,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

const task: SupervisionTaskDescriptor = {
	taskId: "TASK-001",
	analysisStart: "2026-01-01",
	analysisEnd: "2026-06-30",
	organizationId: "ORG-001",
};

function material(overrides: Partial<SupervisionMaterial> = {}): SupervisionMaterial {
	return {
		documentId: "DOC-001",
		documentVersionId: "DOC-001-V1",
		parseVersion: "parse-v1",
		indexVersion: "index-v1",
		title: "监管检查意见函",
		sourceType: "regulatory",
		uploadEntry: "file-center",
		processingStatus: "indexed",
		fileDate: "2026-05-10",
		organizationIds: ["ORG-001"],
		...overrides,
	};
}

function issue(overrides: Partial<SupervisionIssue> = {}): SupervisionIssue {
	return {
		issueId: "ISSUE-001",
		extractionRuleId: "external-regulatory-letter",
		reportSection: "external.regulatory",
		sourceDocumentId: "DOC-001",
		sourceDocumentVersionId: "DOC-001-V1",
		sourceType: "regulatory",
		title: "系统权限回收不及时",
		description: "离岗人员权限未及时关闭",
		organizationIds: ["ORG-001"],
		responsibleDepartmentIds: ["DEPT-IT"],
		category: "system-access",
		severity: "high",
		confirmationStatus: "AUTO_CONFIRMED",
		requiresRectification: true,
		requiresAccountability: false,
		documentNumber: "监管函〔2026〕18号",
		fieldValues: {
			documentTitle: "监管检查意见函",
			documentNumber: "监管函〔2026〕18号",
			documentDate: "2026-05-10",
			organization: "东方证券",
			issueDescription: "离岗人员权限未及时关闭",
			evidenceLocation: "第3页第2段",
			issuingAuthority: "监管机构",
		},
		evidenceIds: ["E-ISSUE-001"],
		...overrides,
	};
}

describe("supervision extraction rules", () => {
	it("covers every report module and the spreadsheet-specific extraction requirements", () => {
		const rules = getSupervisionExtractionRules();
		expect(SUPERVISION_EXTRACTION_RULE_VERSION).toBe("2026-09-10.2");
		expect(new Set(rules.map((rule) => rule.reportSection))).toEqual(
			new Set([
				"external.regulatory",
				"external.audit",
				"internal.audit",
				"internal.compliance",
				"internal.risk",
				"internal.accountability",
				"internal.daily.compliance",
				"internal.daily.risk",
				"internal.daily.litigation",
			]),
		);
		expect(rules.find((rule) => rule.ruleId === "internal-risk-inspection")?.searchKeywords).toContain("整改");
		expect(
			rules.find((rule) => rule.ruleId === "daily-risk-supervision")?.extractFields.map((item) => item.key),
		).toEqual(expect.arrayContaining(["documentTitle", "specificMatter", "riskOfficer"]));
		expect(rules.find((rule) => rule.ruleId === "daily-litigation")?.extractFields.map((item) => item.key)).toEqual(
			expect.arrayContaining(["plaintiff", "defendant", "cause", "claims", "caseFacts", "progress"]),
		);
	});
});

describe("supervision material snapshot", () => {
	it("keeps only indexed materials from both upload entries and records exclusions", () => {
		const snapshot = createMaterialSnapshot({
			task,
			snapshotAt: "2026-09-01T10:00:00+08:00",
			materials: [
				material(),
				material({
					documentId: "DOC-002",
					documentVersionId: "DOC-002-V1",
					uploadEntry: "supervision",
				}),
				material({
					documentId: "DOC-003",
					documentVersionId: "DOC-003-V1",
					processingStatus: "processing",
				}),
				material({
					documentId: "DOC-004",
					documentVersionId: "DOC-004-V1",
					processingStatus: "failed",
				}),
			],
		});

		expect(snapshot.included).toHaveLength(2);
		expect(new Set(snapshot.included.map((item) => item.uploadEntry))).toEqual(
			new Set(["file-center", "supervision"]),
		);
		expect(snapshot.excluded).toEqual([
			{ documentId: "DOC-003", documentVersionId: "DOC-003-V1", reason: "processing" },
			{ documentId: "DOC-004", documentVersionId: "DOC-004-V1", reason: "failed" },
		]);
	});

	it("filters by the single organization and period while including every source type before RAG", () => {
		const snapshot = createMaterialSnapshot({
			task,
			snapshotAt: "2026-09-01T10:00:00+08:00",
			materials: [
				material(),
				material({
					documentId: "DOC-OTHER-ORG",
					documentVersionId: "DOC-OTHER-ORG-V1",
					organizationIds: ["ORG-002"],
				}),
				material({
					documentId: "DOC-OUTSIDE-PERIOD",
					documentVersionId: "DOC-OUTSIDE-PERIOD-V1",
					fileDate: "2025-12-31",
				}),
				material({
					documentId: "DOC-RISK",
					documentVersionId: "DOC-RISK-V1",
					sourceType: "risk",
				}),
			],
		});

		expect(snapshot.included.map((item) => item.documentId)).toEqual(["DOC-001", "DOC-RISK"]);
		expect(snapshot.excluded.map((item) => item.reason)).toEqual([
			"ORGANIZATION_NOT_MATCHED",
			"OUTSIDE_ANALYSIS_PERIOD",
		]);
		expect(buildSupervisionRetrievalScope(task, snapshot)).toEqual({
			taskId: "TASK-001",
			organizationId: "ORG-001",
			documentIds: ["DOC-001", "DOC-RISK"],
			documentVersionIds: ["DOC-001-V1", "DOC-RISK-V1"],
			indexVersions: ["index-v1"],
		});
	});

	it("rejects duplicate document versions instead of silently changing the snapshot", () => {
		expect(() =>
			createMaterialSnapshot({
				task,
				snapshotAt: "2026-09-01T10:00:00+08:00",
				materials: [material(), material({ documentId: "DOC-COPY" })],
			}),
		).toThrow(/duplicate documentVersionId.*DOC-001-V1/i);
	});
});

describe("supervision unified analysis period and task form", () => {
	const payload = () => ({
		task,
		snapshotAt: "2026-09-01T00:00:00Z",
		materials: [material()],
		issues: [issue()],
		rectifications: [],
		accountabilities: [],
	});

	it("accepts an optional analysis description without a source selection or report selector", () => {
		expect(parseSupervisionAnalysisPayload(payload()).task).toEqual(task);
		expect(
			parseSupervisionAnalysisPayload({
				...payload(),
				task: { ...task, analysisDescription: "  关注权限回收和整改进展。  " },
			}).task,
		).toEqual({ ...task, analysisDescription: "关注权限回收和整改进展。" });
		expect(
			parseSupervisionAnalysisPayload({ ...payload(), task: { ...task, analysisDescription: " \n " } }).task,
		).toEqual(task);
		expect(() =>
			parseSupervisionAnalysisPayload({ ...payload(), task: { ...task, analysisDescription: 123 } }),
		).toThrow(/analysisDescription/u);
	});

	it.each(["rectificationAsOf", "sourceTypes", "reportScope"])("rejects the removed task option %s", (key) => {
		expect(() => parseSupervisionAnalysisPayload({ ...payload(), task: { ...task, [key]: "obsolete" } })).toThrow(
			key,
		);
	});

	it.each([
		["2026-01-01", "2026-02-30"],
		["2026-07-01", "2026-06-30"],
		["2026/01/01", "2026-06-30"],
	])("rejects an invalid analysis period %s to %s", (analysisStart, analysisEnd) => {
		expect(() =>
			parseSupervisionAnalysisPayload({ ...payload(), task: { ...task, analysisStart, analysisEnd } }),
		).toThrow();
	});

	it("includes both period boundaries and excludes earlier, later and invalid file dates", () => {
		const dates = ["2025-12-31", "2026-01-01", "2026-06-30", "2026-07-01", "2026-02-30"];
		const snapshot = createMaterialSnapshot({
			...payload(),
			materials: dates.map((fileDate) =>
				material({ documentId: fileDate, documentVersionId: `${fileDate}-V1`, fileDate }),
			),
		});
		expect(snapshot.included.map((item) => item.fileDate)).toEqual(["2026-01-01", "2026-06-30"]);
		expect(snapshot.excluded.map((item) => item.reason)).toEqual([
			"OUTSIDE_ANALYSIS_PERIOD",
			"OUTSIDE_ANALYSIS_PERIOD",
			"INVALID_FILE_DATE",
		]);
	});

	it("counts the latest in-period rectification and never uses later progress or accountability", () => {
		const record = (
			recordId: string,
			asOfDate: string,
			status: SupervisionRectificationRecord["status"],
		): SupervisionRectificationRecord => ({
			recordId,
			asOfDate,
			status,
			sourceDocumentId: "DOC-001",
			sourceDocumentVersionId: "DOC-001-V1",
			referencedIssueIds: ["ISSUE-001"],
			referencedDocumentNumbers: [],
			organizationIds: ["ORG-001"],
			responsibleDepartmentIds: ["DEPT-IT"],
			description: "整改进展",
			evidenceIds: [recordId],
		});
		const scope = scopeSupervisionAnalysisPayload({
			...payload(),
			issues: [
				issue({ discoveredDate: "2026-01-01", requiresAccountability: true }),
				issue({ issueId: "BEFORE", discoveredDate: "2025-12-31" }),
				issue({ issueId: "AFTER", discoveredDate: "2026-07-01" }),
			],
			rectifications: [
				record("BEFORE", "2025-12-31", "NOT_STARTED"),
				record("START", "2026-01-01", "NOT_STARTED"),
				record("END", "2026-06-30", "IN_PROGRESS"),
				record("LATER", "2026-08-31", "COMPLETED"),
			],
			accountabilities: [
				{ ...record("A-END", "2026-06-30", "IN_PROGRESS"), action: "通报" },
				{ ...record("A-LATER", "2026-07-01", "COMPLETED"), action: "通报" },
			],
		});
		expect(scope.issues.map((item) => item.issueId)).toEqual(["ISSUE-001"]);
		expect(scope.rectifications.map((item) => item.recordId)).toEqual(["START", "END"]);
		expect(scope.accountabilities.map((item) => item.recordId)).toEqual(["A-END"]);
		const relations = associateSupervisionRecords(scope);
		expect(relations.map((item) => item.selectedRecordId)).toEqual(["END", "A-END"]);
		const result = buildSupervisionAnalysisResult({ task, ...scope, relations });
		expect(result.statistics.rectification).toMatchObject({
			confirmedTotal: 1,
			completedTotal: 0,
			completionRate: 0,
		});
		expect(result.task).toEqual(task);
	});
});

describe("supervision rectification and accountability association", () => {
	it("auto-confirms an explicit issue-id reference", () => {
		const relations = associateSupervisionRecords({
			issues: [issue()],
			rectifications: [
				{
					recordId: "RECT-001",
					sourceDocumentId: "DOC-RECT-001",
					referencedIssueIds: ["ISSUE-001"],
					referencedDocumentNumbers: [],
					organizationIds: ["ORG-001"],
					responsibleDepartmentIds: ["DEPT-IT"],
					description: "已完成离岗人员权限清理",
					status: "COMPLETED",
					evidenceIds: ["E-RECT-001"],
				},
			],
			accountabilities: [],
		});

		expect(relations).toHaveLength(1);
		expect(relations[0]).toMatchObject({
			issueId: "ISSUE-001",
			relationType: "RECTIFICATION",
			status: "AUTO_CONFIRMED",
			selectedRecordId: "RECT-001",
			matchMethod: "EXACT_ISSUE_ID",
		});
	});

	it("sends close semantic candidates to multiple-candidate review", () => {
		const relations = associateSupervisionRecords(
			{
				issues: [issue({ documentNumber: undefined })],
				rectifications: [
					{
						recordId: "RECT-001",
						sourceDocumentId: "DOC-RECT-001",
						referencedIssueIds: [],
						referencedDocumentNumbers: [],
						organizationIds: ["ORG-001"],
						responsibleDepartmentIds: ["DEPT-IT"],
						description: "权限清理整改",
						status: "IN_PROGRESS",
						semanticScore: 0.82,
						evidenceIds: ["E-RECT-001"],
					},
					{
						recordId: "RECT-002",
						sourceDocumentId: "DOC-RECT-002",
						referencedIssueIds: [],
						referencedDocumentNumbers: [],
						organizationIds: ["ORG-001"],
						responsibleDepartmentIds: ["DEPT-IT"],
						description: "离岗权限整改",
						status: "IN_PROGRESS",
						semanticScore: 0.8,
						evidenceIds: ["E-RECT-002"],
					},
				],
				accountabilities: [],
			},
			new Map([
				[JSON.stringify(["ISSUE-001", "RECT-001"]), 0.82],
				[JSON.stringify(["ISSUE-001", "RECT-002"]), 0.8],
			]),
		);

		expect(relations[0]).toMatchObject({
			status: "MULTIPLE_CANDIDATES",
			candidateRecordIds: ["RECT-001", "RECT-002"],
		});
	});

	it("never auto-confirms conflicting rectification states", () => {
		const relations = associateSupervisionRecords({
			issues: [issue()],
			rectifications: [
				{
					recordId: "RECT-001",
					sourceDocumentId: "DOC-RECT-001",
					referencedIssueIds: [],
					referencedDocumentNumbers: ["监管函〔2026〕18号"],
					organizationIds: ["ORG-001"],
					responsibleDepartmentIds: ["DEPT-IT"],
					description: "整改完成",
					status: "COMPLETED",
					evidenceIds: ["E-RECT-001"],
				},
				{
					recordId: "RECT-002",
					sourceDocumentId: "DOC-RECT-002",
					referencedIssueIds: [],
					referencedDocumentNumbers: ["监管函〔2026〕18号"],
					organizationIds: ["ORG-001"],
					responsibleDepartmentIds: ["DEPT-IT"],
					description: "仍在整改",
					status: "IN_PROGRESS",
					evidenceIds: ["E-RECT-002"],
				},
			],
			accountabilities: [],
		});

		// Same document can contain separate issues with different progress states.
		expect(relations[0]?.status).toBe("MULTIPLE_CANDIDATES");
	});

	it("does not create a false missing-accountability exception when accountability is not required", () => {
		const relations = associateSupervisionRecords({
			issues: [issue({ requiresRectification: false, requiresAccountability: false })],
			rectifications: [],
			accountabilities: [],
		});
		expect(relations).toEqual([]);
	});
});

describe("supervision statistics and outward contract", () => {
	it("counts only confirmed issues and confirmed relations", async () => {
		const issues = [
			issue(),
			issue({
				issueId: "ISSUE-002",
				confirmationStatus: "PENDING_REVIEW",
				requiresRectification: false,
			}),
		];
		const rectifications = [
			{
				recordId: "RECT-001",
				sourceDocumentId: "DOC-RECT-001",
				referencedIssueIds: ["ISSUE-001"],
				referencedDocumentNumbers: [],
				organizationIds: ["ORG-001"],
				responsibleDepartmentIds: ["DEPT-IT"],
				description: "已整改",
				status: "COMPLETED" as const,
				evidenceIds: ["E-RECT-001"],
			},
		];
		const relations = associateSupervisionRecords({ issues, rectifications, accountabilities: [] });
		const statistics = buildSupervisionStatistics({
			issues,
			relations,
			rectifications,
			accountabilities: [],
		});

		expect(statistics.issueTotal).toBe(1);
		expect(statistics.pendingIssueReviewTotal).toBe(1);
		expect(statistics.rectification.confirmedTotal).toBe(1);
		expect(statistics.rectification.completedTotal).toBe(1);
		expect(statistics.rectification.completionRate).toBe(1);

		const snapshot = createMaterialSnapshot({
			task,
			snapshotAt: "2026-09-01T10:00:00+08:00",
			materials: [material()],
		});
		const result = buildSupervisionAnalysisResult({
			task: {
				taskId: "TASK-001",
				analysisStart: "2026-01-01",
				analysisEnd: "2026-06-30",
				organizationId: "ORG-001",
			},
			snapshot,
			issues,
			rectifications,
			accountabilities: [],
			relations,
		});
		const schema = JSON.parse(
			await readFile(join(packageRoot, "specs", "supervision-analysis", "output-contract.schema.json"), "utf8"),
		) as unknown;

		expect(result.schemaVersion).toBe("supervision-analysis.v1");
		expect(result.readiness.status).toBe("READY_WITH_WARNINGS");
		expect(Value.Check(schema as TSchema, result)).toBe(true);
	});

	it("runs the supervision RuntimeSpec through its bound toolset and output contract", async () => {
		const rectifications = [
			{
				recordId: "RECT-001",
				sourceDocumentId: "DOC-RECT-001",
				referencedIssueIds: ["ISSUE-001"],
				referencedDocumentNumbers: [],
				organizationIds: ["ORG-001"],
				responsibleDepartmentIds: ["DEPT-IT"],
				description: "已整改",
				status: "COMPLETED" as const,
				evidenceIds: ["E-RECT-001"],
			},
		];
		const payload = {
			task: {
				taskId: "TASK-001",
				analysisStart: "2026-01-01",
				analysisEnd: "2026-06-30",
				organizationId: "ORG-001",
			},
			snapshotAt: "2026-09-01T10:00:00+08:00",
			materials: [material(), material({ documentId: "DOC-RECT-001", documentVersionId: "DOC-RECT-001-V1" })],
			issues: [issue()],
			rectifications,
			accountabilities: [],
		};
		const snapshot = createMaterialSnapshot({
			task: payload.task,
			snapshotAt: payload.snapshotAt,
			materials: payload.materials,
		});
		const relations = associateSupervisionRecords({
			issues: payload.issues,
			rectifications,
			accountabilities: [],
		});
		const expected = buildSupervisionAnalysisResult({
			task: payload.task,
			snapshot,
			issues: payload.issues,
			rectifications,
			accountabilities: [],
			relations,
		});
		const specPath = join(packageRoot, "specs", "supervision-analysis.json");
		const spec = JSON.parse(await readFile(specPath, "utf8")) as RuntimeSpec;
		await resolveSpecPromptPaths(spec, dirname(specPath));
		const outputContractSchema = JSON.parse(
			await readFile(join(packageRoot, "specs", "supervision-analysis", "output-contract.schema.json"), "utf8"),
		) as unknown;
		expect(
			Value.Check(outputContractSchema as TSchema, expected),
			JSON.stringify([...Value.Errors(outputContractSchema as TSchema, expected)]),
		).toBe(true);
		const harness = await createFauxHarness();
		const toolsets = new ToolsetRegistry();
		toolsets.register("supervision-analysis", createSupervisionAnalysisToolset(payload));
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("build_supervision_analysis_result", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``),
		]);
		const runtime = await createSessionRuntime({
			spec,
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets,
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			outputContractSchema,
		});
		try {
			const result = await runtime.run("生成监督共享信息汇总分析结果");
			expect(result.status, JSON.stringify(result)).toBe("completed");
			expect(result.output).toContain('"schemaVersion":"supervision-analysis.v1"');
			expect(result.output).toContain('"taskId":"TASK-001"');
		} finally {
			await runtime.dispose();
			await harness.cleanup();
		}
	}, 15_000);
});
