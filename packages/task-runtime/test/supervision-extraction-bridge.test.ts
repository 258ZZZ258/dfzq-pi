import { readFileSync } from "node:fs";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { associateSupervisionRecords } from "../src/supervision-analysis/association.ts";
import { buildSupervisionAnalysisResult } from "../src/supervision-analysis/result.ts";
import { getSupervisionExtractionRules } from "../src/supervision-analysis/rules.ts";
import { pairKey } from "../src/supervision-analysis/semantic.ts";
import { scopeSupervisionAnalysisPayload } from "../src/supervision-analysis/snapshot.ts";
import { verifyAndConvertExtractions } from "../src/supervision-analysis/verify-fields.ts";
import {
	createSupervisionAnalysisToolset,
	parseSupervisionAnalysisPayload,
} from "../src/toolsets/supervision-analysis.ts";

function extraction(ruleId = "internal-risk-inspection", version = "V1", overrides: Record<string, string> = {}) {
	const rule = getSupervisionExtractionRules().find((r) => r.ruleId === ruleId)!;
	const fields = Object.fromEntries(rule.extractFields.filter((f) => f.required).map((f) => [f.key, f.label]));
	Object.assign(
		fields,
		{
			documentDate: "2026-06-30",
			issueDescription: "终端未登记",
			rectificationMeasure: "补录终端",
			rectificationStatus: "已完成",
		},
		overrides,
	);
	for (const key of Object.keys(fields)) if (!rule.extractFields.some((f) => f.key === key)) delete fields[key];
	const text = Object.values(fields).join("；");
	return {
		schemaVersion: "supervision-extraction.v1",
		extractionStatus: "EXTRACTED",
		uploadedMaterial: {
			documentId: version,
			documentVersionId: version,
			fileName: "资料.pdf",
			issueDate: "2026-06-30",
			categoryCode: "C",
			documentOrigin: "internal",
			organizationIds: ["O"],
			uploadEntry: "supervision",
			processingStatus: "indexed",
			parseVersion: "P",
			indexVersion: "I",
		},
		evidence: [{ evidenceId: version, documentId: version, documentVersionId: version, text }],
		facts: [
			{
				factId: "F",
				factType: ruleId === "daily-litigation" ? "LITIGATION" : "FINDING",
				ruleId,
				reportSection: rule.reportSection,
				organizationIds: ["O"],
				missingRequiredFields: [],
				confirmationStatus: "PENDING_REVIEW",
				values: Object.fromEntries(
					Object.entries(fields).map(([key, value]) => [key, { value, evidenceId: version, quote: value }]),
				),
			},
		],
	};
}
function payload(outputs = [extraction()], sourceType = "risk") {
	return {
		task: { taskId: "T", organizationId: "O", analysisStart: "2026-01-01", analysisEnd: "2026-06-30" },
		snapshotAt: "2026-07-01",
		categoryMappings: [{ categoryCode: "C", sourceType }],
		extractionResults: outputs,
	};
}
function run(input: ReturnType<typeof payload>) {
	const parsed = parseSupervisionAnalysisPayload(input);
	const scope = scopeSupervisionAnalysisPayload(parsed);
	return buildSupervisionAnalysisResult({
		task: parsed.task,
		...scope,
		relations: associateSupervisionRecords(scope),
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("keeps a follow-up report as a standalone record and matches it to the original finding", () => {
	const original = extraction("internal-risk-inspection", "V1");
	delete original.facts[0].values.rectificationMeasure;
	delete original.facts[0].values.rectificationStatus;
	const progress = extraction("internal-risk-inspection", "V2");
	progress.facts[0].factType = "RECTIFICATION";
	const parsed = parseSupervisionAnalysisPayload(payload([original, progress]));
	expect(parsed.issues).toHaveLength(1);
	expect(parsed.rectifications).toHaveLength(1);
	expect(parsed.rectifications[0].referencedIssueIds).toEqual([]);
	const issue = parsed.issues[0];
	const record = parsed.rectifications[0];
	const key = pairKey(issue.issueId, record.recordId);
	const relations = associateSupervisionRecords(
		parsed,
		new Map([[key, 0.99]]),
		new Map([
			[
				key,
				{
					pairId: key,
					verdict: "MATCH",
					reason: "同一终端登记事项",
					issueQuote: issue.description,
					recordQuote: record.description,
				},
			],
		]),
	);
	expect(relations.find((r) => r.relationType === "RECTIFICATION")?.selectedRecordId).toBe(record.recordId);
});

it("preserves independent rectification with no repeated finding", () => {
	const progress = extraction();
	progress.facts[0].factType = "RECTIFICATION";
	delete progress.facts[0].values.issueDescription;
	const parsed = parseSupervisionAnalysisPayload(payload([progress]));
	expect(parsed.issues).toHaveLength(0);
	expect(parsed.rectifications[0]).toMatchObject({ confirmationStatus: "AUTO_CONFIRMED", referencedIssueIds: [] });
});

it("counts an independently verified accountability decision without creating a new finding", () => {
	const decision = extraction("internal-accountability");
	decision.facts[0].factType = "ACCOUNTABILITY";
	const result = run(payload([decision], "accountability"));
	expect(result.issues).toHaveLength(0);
	expect(result.accountabilities).toHaveLength(1);
	expect(result.statistics.accountability.confirmedTotal).toBe(1);
});

it("rejects unsupported values locally and honors remote rejection even for verbatim values", async () => {
	const source = extraction();
	source.facts[0].values.issueDescription.value = "挪用资金100万元";
	expect(run(payload([source])).statistics.issueTotal).toBe(0);
	vi.stubEnv("AUDIT_AI_BASE_URL", "http://audit.test");
	vi.stubEnv("AUDIT_AI_INTERNAL_TOKEN", "test");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as { claims: { id: string; field: string }[] };
			return Response.json({
				verdicts: body.claims.map((claim) => ({
					id: claim.id,
					supported: claim.field !== "issueDescription",
					reason: "证据核对",
				})),
			});
		}),
	);
	const verified = await verifyAndConvertExtractions([extraction()], [{ categoryCode: "C", sourceType: "risk" }]);
	expect(verified.issues[0].confirmationStatus).toBe("PENDING_REVIEW");
	const factoryResult = await createSupervisionAnalysisToolset(payload())();
	expect(Array.isArray(factoryResult)).toBe(true);
	expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/v1/supervision/verify-fields"))).toBe(
		true,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ verdicts: [] })),
	);
	await expect(
		verifyAndConvertExtractions([extraction()], [{ categoryCode: "C", sourceType: "risk" }]),
	).rejects.toThrow("Incomplete");
});

it("separates completion and coverage denominators and classifies explicit category evidence", () => {
	const first = extraction("internal-risk-inspection", "V1", { issueDescription: "合同未审批" });
	const second = extraction("internal-risk-inspection", "V2", { issueDescription: "系统权限未及时回收" });
	delete second.facts[0].values.rectificationMeasure;
	delete second.facts[0].values.rectificationStatus;
	const result = run(payload([first, second]));
	expect(result.statistics.rectification).toMatchObject({
		requiredTotal: 2,
		unmatchedTotal: 1,
		completionRate: 0.5,
		matchedCompletionRate: 1,
		coverageRate: 0.5,
	});
	expect(result.statistics.byCategory).toEqual({ 合同管理: 1, 系统权限管理: 1 });
});

it("excludes a month-end litigation snapshot from a mid-month period", () => {
	const input = payload(
		[extraction("daily-litigation", "V1", { reportMonth: "2026-06", caseNumber: "甲1号" })],
		"litigation",
	);
	input.task.analysisEnd = "2026-06-15";
	input.extractionResults[0].uploadedMaterial.issueDate = "2026-06-10";
	expect(run(input).issues).toHaveLength(0);
});

it("converts evidence-checked candidates through the production parser into confirmed statistics", () => {
	const result = run(payload());
	expect(result.statistics.issueTotal).toBe(1);
	expect(result.statistics.rectification.completedTotal).toBe(1);
	expect(result.issues[0].severity).toBe("unknown");
	expect(run(payload()).issues[0].issueId).toBe(result.issues[0].issueId);
	const schema = JSON.parse(
		readFileSync(new URL("../specs/supervision-analysis/output-contract.schema.json", import.meta.url), "utf8"),
	);
	expect(Value.Check(schema, result)).toBe(true);
});

it("does not confirm inconsistent dates or infer completion from an unfamiliar status", () => {
	const mismatch = run(payload([extraction("internal-risk-inspection", "V1", { documentDate: "2026-05-31" })]));
	expect(mismatch.statistics.issueTotal).toBe(0);
	const unknown = run(
		payload([extraction("internal-risk-inspection", "V1", { rectificationStatus: "正在验收，尚无结论" })]),
	);
	expect(unknown.statistics.rectification.completedTotal).toBe(0);
	expect(unknown.statistics.rectification.byStatus.PENDING_REVIEW).toBe(1);
});
it("recomputes required fields rather than trusting the model confirmation or missing-field list", () => {
	const input = payload();
	delete input.extractionResults[0].facts[0].values.organization;
	const result = run(input);
	expect(result.statistics.issueTotal).toBe(0);
	expect(result.statistics.pendingIssueReviewTotal).toBe(1);
	expect(result.statistics.rectification.confirmedTotal).toBe(0);
});
it("rejects forged citations, wrong versions, duplicate facts and mixed entry modes", () => {
	const quote = payload();
	quote.extractionResults[0].facts[0].values.issueDescription.quote = "不存在";
	expect(() => run(quote)).toThrow("quote");
	const version = payload();
	version.extractionResults[0].evidence[0].documentVersionId = "OTHER";
	expect(() => run(version)).toThrow("version");
	const duplicate = payload();
	duplicate.extractionResults[0].facts.push(duplicate.extractionResults[0].facts[0]);
	expect(() => run(duplicate)).toThrow("Duplicate");
	expect(() => parseSupervisionAnalysisPayload({ ...payload(), issues: [] })).toThrow("mixed");
});
it("selects latest month per lawsuit, excluding out-of-period snapshots without losing other cases", () => {
	const outputs = [
		extraction("daily-litigation", "V1", { reportMonth: "2026年3月", caseNumber: "(2026)甲1号", progress: "审理中" }),
		extraction("daily-litigation", "V2", { reportMonth: "2026-06", caseNumber: "（2026）甲1号", progress: "已执行" }),
		extraction("daily-litigation", "V3", { reportMonth: "2026-07", caseNumber: "(2026)甲1号", progress: "期间外" }),
		extraction("daily-litigation", "V4", { reportMonth: "2026-05", caseNumber: "(2026)乙2号", progress: "审理中" }),
	];
	const result = run(payload(outputs, "litigation"));
	expect(result.statistics.issueTotal).toBe(2);
	expect(result.issues.map((r) => r.sourceDocumentVersionId).sort()).toEqual(["V2", "V4"]);
});
it("keeps missing case IDs and same-month conflicts pending rather than double counting", () => {
	const outputs = [
		extraction("daily-litigation", "V1", { reportMonth: "2026-06", caseNumber: "甲1号", progress: "审理中" }),
		extraction("daily-litigation", "V2", { reportMonth: "2026-06", caseNumber: "甲1号", progress: "已执行" }),
		extraction("daily-litigation", "V3", { reportMonth: "2026-06" }),
	];
	const result = run(payload(outputs, "litigation"));
	expect(result.statistics.issueTotal).toBe(0);
	expect(result.statistics.pendingIssueReviewTotal).toBe(3);
});
