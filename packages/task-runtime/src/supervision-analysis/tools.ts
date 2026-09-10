import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { associateSupervisionRecords, associationCandidates } from "./association.ts";
import type {
	SupervisionAnalysisPayload,
	SupervisionAnalysisResult,
	SupervisionAnalysisScope,
	SupervisionMaterialSnapshot,
	SupervisionRelation,
} from "./contracts.ts";
import { type AssociationDecision, judgeAssociationCandidates } from "./judgement.ts";
import { buildSupervisionAnalysisResult } from "./result.ts";
import { getSupervisionExtractionRules, SUPERVISION_EXTRACTION_RULE_VERSION } from "./rules.ts";
import { computeAssociationScores } from "./semantic.ts";
import { buildSupervisionRetrievalScope, scopeSupervisionAnalysisPayload } from "./snapshot.ts";
import { parseSupervisionTask } from "./task.ts";

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

interface AnalysisContext {
	payload: SupervisionAnalysisPayload;
	scope?: SupervisionAnalysisScope;
	relations?: SupervisionRelation[];
	associationDecisions?: readonly AssociationDecision[];
	result?: SupervisionAnalysisResult;
}

function ensureScope(context: AnalysisContext): SupervisionAnalysisScope {
	context.scope ??= scopeSupervisionAnalysisPayload(context.payload);
	return context.scope;
}

function ensureSnapshot(context: AnalysisContext): SupervisionMaterialSnapshot {
	return ensureScope(context).snapshot;
}

async function ensureRelations(context: AnalysisContext): Promise<SupervisionRelation[]> {
	const scope = ensureScope(context);
	if (context.relations) return context.relations;
	const scores = await computeAssociationScores(scope);
	const decisions = await judgeAssociationCandidates(scope, associationCandidates(scope, scores));
	context.associationDecisions = [...decisions.values()];
	context.relations ??= associateSupervisionRecords(
		{
			issues: scope.issues,
			rectifications: scope.rectifications,
			accountabilities: scope.accountabilities,
		},
		scores,
		decisions,
	);
	return context.relations;
}

export function createSupervisionAnalysisTools(payload: SupervisionAnalysisPayload): ToolDefinition[] {
	const context: AnalysisContext = { payload: { ...payload, task: parseSupervisionTask(payload.task) } };
	const getTask = defineTool({
		name: "get_supervision_task",
		label: "Get supervision analysis task",
		description:
			"Get the analysis period, single organization and optional analysis background for the fixed supervision report.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			return toolResult(JSON.stringify(context.payload.task, null, 2), { task: context.payload.task });
		},
	});

	const getSnapshot = defineTool({
		name: "get_supervision_material_snapshot",
		label: "Get immutable supervision material snapshot",
		description:
			"Return indexed materials from both upload entries and list processing, failed or disabled exclusions.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const snapshot = ensureSnapshot(context);
			return toolResult(JSON.stringify(snapshot, null, 2), { snapshot });
		},
	});

	const getRetrievalScope = defineTool({
		name: "get_supervision_retrieval_scope",
		label: "Get supervision RAG retrieval scope",
		description:
			"Return the immutable document and index-version filters that every keyword, dense or sparse retrieval request must use.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const retrievalScope = buildSupervisionRetrievalScope(context.payload.task, ensureSnapshot(context));
			return toolResult(JSON.stringify(retrievalScope, null, 2), { retrievalScope });
		},
	});

	const getRules = defineTool({
		name: "get_supervision_extraction_rules",
		label: "Get supervision extraction rules",
		description:
			"Return the versioned report sections, document hints, keywords, priority content and required extraction fields.",
		parameters: Type.Object({
			sourceType: Type.Optional(
				Type.Union([
					Type.Literal("regulatory"),
					Type.Literal("external-audit"),
					Type.Literal("internal-audit"),
					Type.Literal("compliance"),
					Type.Literal("risk"),
					Type.Literal("accountability"),
					Type.Literal("routine-supervision"),
					Type.Literal("litigation"),
				]),
			),
			reportSection: Type.Optional(
				Type.Union([
					Type.Literal("external.regulatory"),
					Type.Literal("external.audit"),
					Type.Literal("internal.audit"),
					Type.Literal("internal.compliance"),
					Type.Literal("internal.risk"),
					Type.Literal("internal.accountability"),
					Type.Literal("internal.daily.compliance"),
					Type.Literal("internal.daily.risk"),
					Type.Literal("internal.daily.litigation"),
				]),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const rules = getSupervisionExtractionRules(params);
			const result = { version: SUPERVISION_EXTRACTION_RULE_VERSION, rules };
			return toolResult(JSON.stringify(result, null, 2), result);
		},
	});

	const listIssues = defineTool({
		name: "list_supervision_issue_candidates",
		label: "List extracted supervision issue candidates",
		description:
			"Return complete extracted issue candidates with source document versions and evidence IDs. Missing values stay missing.",
		parameters: Type.Object({
			confirmationStatus: Type.Optional(
				Type.Union([
					Type.Literal("AUTO_CONFIRMED"),
					Type.Literal("HUMAN_CONFIRMED"),
					Type.Literal("PENDING_REVIEW"),
				]),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const scopedIssues = ensureScope(context).issues;
			const issues = params.confirmationStatus
				? scopedIssues.filter((issue) => issue.confirmationStatus === params.confirmationStatus)
				: scopedIssues;
			return toolResult(JSON.stringify(issues, null, 2), { issues });
		},
	});

	const associate = defineTool({
		name: "associate_supervision_records",
		label: "Associate rectification and accountability records",
		description:
			"Apply exact-reference and composite matching. Auto-confirm unambiguous matches and return exceptions for review.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const relations = await ensureRelations(context);
			return toolResult(JSON.stringify(relations, null, 2), {
				relations,
				associationDecisions: context.associationDecisions,
			});
		},
	});

	const buildResult = defineTool({
		name: "build_supervision_analysis_result",
		label: "Build confirmed statistics and report-ready result",
		description:
			"Build the complete supervision-analysis.v1 payload. Statistics include only confirmed issues and relations.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const scope = ensureScope(context);
			context.result = buildSupervisionAnalysisResult({
				task: context.payload.task,
				snapshot: scope.snapshot,
				issues: scope.issues,
				rectifications: scope.rectifications,
				accountabilities: scope.accountabilities,
				relations: await ensureRelations(context),
				continuousAsCompleted: context.payload.continuousAsCompleted,
			});
			return toolResult(JSON.stringify(context.result, null, 2), {
				result: context.result,
				associationDecisions: context.associationDecisions,
			});
		},
	});

	return [getTask, getSnapshot, getRetrievalScope, getRules, listIssues, associate, buildResult];
}
