import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	createAuditReportRequestContext,
	recordReportToolTrace,
	requireAuditReportRequestContext,
	withAuditReportRequestContext,
} from "./report-context.ts";
import type { AuditFinding, AuditReportDataset, ReportDraft } from "./report-contracts.ts";
import { reportDocumentMatches, toAuditReportJavaDocument } from "./report-java-contract.ts";
import {
	buildFactPack,
	comparePreviousAuditFindings,
	generateReportDraft,
	normalizeChineseProse,
} from "./report-pipeline.ts";

function result(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function allowedPath(root: string, candidate: string): string | undefined {
	const target = resolve(root, candidate);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? target : undefined;
}

function assertOrganization(organizationId: string): string | undefined {
	const { dataset } = requireAuditReportRequestContext();
	return organizationId === dataset.task.organizationId
		? undefined
		: `Access denied: organization ${organizationId} is outside task ${dataset.task.taskId}.`;
}

function findingSummary(finding: AuditFinding): Record<string, unknown> {
	return {
		findingId: finding.findingId,
		title: finding.title,
		category: finding.category,
		severity: finding.severity,
		issueCount: finding.issueCount,
		status: finding.status,
	};
}

function reportParagraphs(draft: ReportDraft) {
	return [
		draft.introduction,
		...draft.sections.flatMap((section) => [
			...section.paragraphs,
			...section.subsections.flatMap((subsection) => subsection.paragraphs),
			...(section.closingParagraphs ?? []),
		]),
	];
}

function reportTables(draft: ReportDraft) {
	return draft.sections.flatMap((section) => [
		...section.tables,
		...section.subsections.flatMap((subsection) => subsection.tables ?? []),
	]);
}

function reportEvidenceIds(draft: ReportDraft): string[] {
	return [
		...draft.allEvidenceIds,
		...reportParagraphs(draft).flatMap((paragraph) => paragraph.evidenceIds),
		...reportTables(draft).flatMap((table) => table.sourceEvidenceIds),
	];
}

function baselineCompletenessErrors(baseline: ReportDraft, draft: ReportDraft): string[] {
	const draftSectionHeadings = new Set(draft.sections.map((section) => section.heading));
	const draftParagraphs = new Map(reportParagraphs(draft).map((paragraph) => [paragraph.paragraphId, paragraph]));
	const draftTableIds = new Set(reportTables(draft).map((table) => table.tableId));
	const draftEvidence = new Set(draft.allEvidenceIds);
	const missingSections = baseline.sections
		.map((section) => section.heading)
		.filter((heading) => !draftSectionHeadings.has(heading));
	const missingParagraphs = reportParagraphs(baseline)
		.map((paragraph) => paragraph.paragraphId)
		.filter((paragraphId) => !draftParagraphs.has(paragraphId));
	const missingTables = reportTables(baseline)
		.map((table) => table.tableId)
		.filter((tableId) => !draftTableIds.has(tableId));
	const missingEvidence = baseline.allEvidenceIds.filter((evidenceId) => !draftEvidence.has(evidenceId));
	const disabledHumanReview = reportParagraphs(baseline)
		.filter((paragraph) => paragraph.requiresHumanReview)
		.map((paragraph) => paragraph.paragraphId)
		.filter((paragraphId) => draftParagraphs.get(paragraphId)?.requiresHumanReview !== true);
	return [
		...(missingSections.length === 0 ? [] : [`missing required sections: ${missingSections.join(", ")}`]),
		...(missingParagraphs.length === 0
			? []
			: [`missing required paragraphs: ${missingParagraphs.slice(0, 20).join(", ")}`]),
		...(missingTables.length === 0 ? [] : [`missing required tables: ${missingTables.join(", ")}`]),
		...(missingEvidence.length === 0
			? []
			: [`missing baseline evidence IDs: ${missingEvidence.slice(0, 20).join(", ")}`]),
		...(disabledHumanReview.length === 0
			? []
			: [`human-review flags removed: ${disabledHumanReview.slice(0, 20).join(", ")}`]),
		...(draft.status === baseline.status ? [] : [`status must remain ${baseline.status}`]),
	];
}

const ParagraphChangesSchema = Type.Array(
	Type.Object(
		{
			paragraphId: Type.String({ minLength: 1 }),
			text: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
);

const llmEditableParagraphIds = new Set([
	"regular-operating-analysis",
	"turnover-operating-analysis",
	"turnover-historical-findings",
]);

export function createAuditReportRestrictedReadTool(skillRoot: string): ToolDefinition {
	return defineTool({
		name: "read",
		label: "read (audit report skill only)",
		description: "Read only the audit-report Skill and its reference files.",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const target = allowedPath(skillRoot, params.path);
			if (!target) {
				return result("Access denied: only audit-report Skill files are readable.", { blocked: true });
			}
			try {
				await access(target);
				const lines = (await readFile(target, "utf8")).split("\n");
				const start = (params.offset ?? 1) - 1;
				const selected = lines.slice(start, start + (params.limit ?? 500));
				return result(selected.join("\n"), {
					path: target,
					lineCount: selected.length,
				});
			} catch {
				return result("Skill file not found.", { missing: true });
			}
		},
	});
}

export function createAuditReportTools(skillRoot: string): ToolDefinition[] {
	const getTask = defineTool({
		name: "get_report_task",
		label: "Get audit report task",
		description: "Get the current report type, organization, audit period, subject and output template.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const { dataset } = requireAuditReportRequestContext();
			recordReportToolTrace("get_report_task", [dataset.task.taskId]);
			return result(JSON.stringify(dataset.task, null, 2), {
				task: dataset.task,
			});
		},
	});

	const getOrganization = defineTool({
		name: "get_organization_snapshot",
		label: "Get organization snapshot",
		description: "Get the audited organization's point-in-time identity, address, area and history.",
		parameters: Type.Object({ organizationId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			recordReportToolTrace("get_organization_snapshot", [dataset.organization.organizationId]);
			return result(JSON.stringify(dataset.organization, null, 2), {
				organization: dataset.organization,
			});
		},
	});

	const getPersonnel = defineTool({
		name: "get_personnel_snapshot",
		label: "Get personnel snapshot",
		description: "Get the audited organization's personnel snapshot as of the audit end date.",
		parameters: Type.Object({ organizationId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			recordReportToolTrace("get_personnel_snapshot", [dataset.personnel.organizationId]);
			return result(JSON.stringify(dataset.personnel, null, 2), {
				personnel: dataset.personnel,
			});
		},
	});

	const listAppointments = defineTool({
		name: "list_appointment_records",
		label: "List appointment records",
		description: "List appointment, removal and acting-duty documents for the report subject.",
		parameters: Type.Object({
			personId: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const { dataset } = requireAuditReportRequestContext();
			const records =
				params.personId === undefined
					? dataset.appointments
					: dataset.appointments.filter((record) => record.personId === params.personId);
			recordReportToolTrace(
				"list_appointment_records",
				records.map((record) => record.documentNumber),
			);
			return result(JSON.stringify(records, null, 2), {
				appointments: records,
			});
		},
	});

	const getMetrics = defineTool({
		name: "get_operating_metrics",
		label: "Get operating metrics",
		description: "Get metric values, units, ranking numerators and participant denominators for the task period.",
		parameters: Type.Object({ organizationId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			recordReportToolTrace(
				"get_operating_metrics",
				dataset.operatingMetrics.map((metric) => metric.metricCode),
			);
			return result(JSON.stringify(dataset.operatingMetrics, null, 2), {
				metrics: dataset.operatingMetrics,
			});
		},
	});

	const listFindings = defineTool({
		name: "list_audit_findings",
		label: "List audit findings",
		description: "List complete finding IDs and metadata. Call get_audit_finding_detail for full text.",
		parameters: Type.Object({
			organizationId: Type.String(),
			category: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			const findings =
				params.category === undefined
					? dataset.findings
					: dataset.findings.filter((finding) => finding.category === params.category);
			recordReportToolTrace(
				"list_audit_findings",
				findings.map((finding) => finding.findingId),
			);
			const summaries = findings.map(findingSummary);
			return result(JSON.stringify(summaries, null, 2), {
				findings: summaries,
			});
		},
	});

	const getFinding = defineTool({
		name: "get_audit_finding_detail",
		label: "Get audit finding detail",
		description: "Get the full, non-truncated finding text, evidence, policy basis and rectification state.",
		parameters: Type.Object({ findingId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const { dataset } = requireAuditReportRequestContext();
			const finding = dataset.findings.find((candidate) => candidate.findingId === params.findingId);
			if (!finding) {
				return result("Finding not found in the current task.", {
					missing: true,
				});
			}
			recordReportToolTrace("get_audit_finding_detail", [finding.findingId]);
			return result(JSON.stringify(finding, null, 2), { finding });
		},
	});

	const listRectifications = defineTool({
		name: "list_rectification_records",
		label: "List rectification records",
		description:
			"Get rectification status for every current finding without deleting completed or unresolved findings.",
		parameters: Type.Object({ organizationId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			const records = dataset.findings.map((finding) => ({
				findingId: finding.findingId,
				status: finding.status,
				evidenceIds: finding.evidenceIds,
			}));
			recordReportToolTrace(
				"list_rectification_records",
				records.map((record) => record.findingId),
			);
			return result(JSON.stringify(records, null, 2), {
				rectifications: records,
			});
		},
	});

	const listRiskEvents = defineTool({
		name: "list_risk_events",
		label: "List risk events",
		description:
			"Get complaint, litigation, penalty, accountability and loss states. Missing is never treated as none.",
		parameters: Type.Object({ organizationId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			recordReportToolTrace(
				"list_risk_events",
				dataset.riskEvents.map((event) => event.eventId),
			);
			return result(JSON.stringify(dataset.riskEvents, null, 2), {
				riskEvents: dataset.riskEvents,
			});
		},
	});

	const getAmlFacts = defineTool({
		name: "get_aml_facts",
		label: "Get AML facts",
		description: "Get six-domain AML coverage, suspicious transaction counts and regulatory letter entries.",
		parameters: Type.Object({ organizationId: Type.String() }),
		executionMode: "sequential",
		async execute(_id, params) {
			const denied = assertOrganization(params.organizationId);
			if (denied) return result(denied, { blocked: true });
			const { dataset } = requireAuditReportRequestContext();
			if (!dataset.aml) {
				return result("AML facts are not applicable to this report task.", {
					notApplicable: true,
				});
			}
			recordReportToolTrace(
				"get_aml_facts",
				dataset.aml.domains.map((domain) => domain.domain),
			);
			return result(JSON.stringify(dataset.aml, null, 2), {
				aml: dataset.aml,
			});
		},
	});

	const prepareFactPack = defineTool({
		name: "prepare_report_fact_pack",
		label: "Prepare report fact pack",
		description:
			"Validate source readiness, calculate ranks and freeze the evidence-bound fact pack before drafting.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const context = requireAuditReportRequestContext();
			context.factPack = buildFactPack(context.dataset);
			recordReportToolTrace("prepare_report_fact_pack", [context.factPack.task.taskId]);
			return result(JSON.stringify(context.factPack, null, 2), {
				factPack: context.factPack,
			});
		},
	});

	const generateDraft = defineTool({
		name: "generate_report_draft",
		label: "Generate evidence-bound report draft",
		description:
			"Generate the structured draft from the frozen fact pack. Blocks instead of inventing missing facts.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const context = requireAuditReportRequestContext();
			context.factPack ??= buildFactPack(context.dataset);
			context.draft = generateReportDraft(context.dataset, context.factPack);
			const document = toAuditReportJavaDocument(context.dataset, context.draft);
			recordReportToolTrace("generate_report_draft", [context.draft.taskId]);
			return result(JSON.stringify(document, null, 2), {
				draft: context.draft,
				document,
			});
		},
	});

	const reviseDraft = defineTool({
		name: "revise_report_draft",
		label: "Revise model-editable report paragraphs",
		description:
			"Patch only allowlisted semantic-analysis paragraphs and return the complete evidence-bound draft. Template text is locked. Final output validation belongs to the Runtime output contract.",
		promptSnippet:
			"Call this tool only when semantic processing is necessary. It may change only regular-operating-analysis, turnover-operating-analysis, or turnover-historical-findings; never alter template-locked content.",
		parameters: Type.Object({
			paragraphChangesJson: Type.String({ minLength: 2, maxLength: 50000 }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const context = requireAuditReportRequestContext();
			context.factPack ??= buildFactPack(context.dataset);
			const baseline = context.draft ?? generateReportDraft(context.dataset, context.factPack);
			context.draft = baseline;
			let parsed: unknown;
			{
				let changes: unknown;
				try {
					changes = JSON.parse(params.paragraphChangesJson);
				} catch {
					return result("Revision rejected: paragraphChangesJson is invalid.", { valid: false });
				}
				if (!Value.Check(ParagraphChangesSchema, changes)) {
					return result("Revision rejected: paragraphChangesJson does not match the patch schema.", {
						valid: false,
					});
				}
				const patched = structuredClone(baseline);
				const paragraphs = new Map(
					reportParagraphs(patched).map((paragraph) => [paragraph.paragraphId, paragraph]),
				);
				const unknownParagraphIds = changes
					.map((change) => change.paragraphId)
					.filter((paragraphId) => !paragraphs.has(paragraphId));
				if (unknownParagraphIds.length > 0) {
					return result(`Revision rejected: unknown paragraph IDs: ${unknownParagraphIds.join(", ")}`, {
						valid: false,
						errors: unknownParagraphIds,
					});
				}
				const lockedParagraphIds = changes
					.map((change) => change.paragraphId)
					.filter((paragraphId) => !llmEditableParagraphIds.has(paragraphId));
				if (lockedParagraphIds.length > 0) {
					return result(
						`Revision rejected: template-locked paragraphs cannot be changed: ${lockedParagraphIds.join(", ")}`,
						{
							valid: false,
							errors: lockedParagraphIds,
						},
					);
				}
				for (const change of changes) {
					const paragraph = paragraphs.get(change.paragraphId);
					if (!paragraph) continue;
					const normalizedText = normalizeChineseProse(change.text);
					if (change.paragraphId === "turnover-historical-findings") {
						const comparison = comparePreviousAuditFindings(context.dataset.findings);
						const missingPreviousTitles = comparison.previousFindings
							.map((finding) => finding.title)
							.filter((title) => !normalizedText.includes(title));
						const missingConfirmedUnrectified = comparison.unrectified
							.map(({ previous }) => previous.title)
							.filter(
								(title) =>
									!normalizedText.includes(title) ||
									(!normalizedText.includes("未有效整改") && !normalizedText.includes("未整改")),
							);
						const sentenceCount = normalizedText.split(/[。！？]/u).filter((item) => item.trim()).length;
						const exposesInternalReasoning =
							/\bF-(?:PREV-)?\d+\b|规则比对|语义一致性判断|细分领域|标题一致|分类相同/u.test(normalizedText);
						if (
							missingPreviousTitles.length > 0 ||
							missingConfirmedUnrectified.length > 0 ||
							sentenceCount > 2 ||
							exposesInternalReasoning
						) {
							return result(
								"Revision rejected: turnover-historical-findings must keep the complete previous-title list, disclose every confirmed unrectified problem, use at most two report-ready sentences, and omit finding IDs or internal comparison reasoning.",
								{
									valid: false,
									errors: [
										...missingPreviousTitles.map((title) => `missing previous title: ${title}`),
										...missingConfirmedUnrectified.map(
											(title) => `missing confirmed unrectified conclusion: ${title}`,
										),
										...(sentenceCount > 2 ? ["more than two sentences"] : []),
										...(exposesInternalReasoning ? ["contains internal comparison reasoning"] : []),
									],
								},
							);
						}
					}
					paragraph.text = normalizedText;
				}
				parsed = patched;
			}
			const draft = parsed as ReportDraft;
			const knownEvidence = new Set(context.dataset.evidence.map((item) => item.evidenceId));
			const cited = reportEvidenceIds(draft);
			const unknown = cited.filter((id) => !knownEvidence.has(id));
			const errors = [
				...(draft.taskId === context.dataset.task.taskId ? [] : ["taskId does not match current task"]),
				...(unknown.length === 0 ? [] : [`unknown evidence IDs: ${unknown.join(", ")}`]),
				...baselineCompletenessErrors(baseline, draft),
				...(context.factPack !== undefined && context.factPack.blockers.length > 0 && draft.status !== "needs-input"
					? ["blocked fact pack must remain needs-input"]
					: []),
			];
			if (errors.length > 0) {
				return result(`Revision rejected: ${errors.join("; ")}`, { valid: false, errors });
			}
			context.draft = draft;
			const document = toAuditReportJavaDocument(context.dataset, draft);
			recordReportToolTrace("revise_report_draft", [draft.taskId]);
			return result(JSON.stringify(document, null, 2), { valid: true, draft, document });
		},
	});

	return [
		defineTool({
			name: "validate_report_document",
			label: "Validate final report consistency",
			description:
				"Read-only comparison with the current tool-generated document. Never accepts a replacement baseline.",
			parameters: Type.Object({ documentJson: Type.String() }),
			executionMode: "sequential",
			async execute(_id, params) {
				const context = requireAuditReportRequestContext();
				let candidate: unknown;
				try {
					candidate = JSON.parse(params.documentJson);
				} catch {
					return result('{"valid":false}', { valid: false });
				}
				if (!context.draft) return result('{"valid":false}', { valid: false });
				const expected = toAuditReportJavaDocument(context.dataset, context.draft);
				const valid = reportDocumentMatches(expected, candidate);
				return result(JSON.stringify({ valid }), { valid });
			},
		}),
		createAuditReportRestrictedReadTool(skillRoot),
		getTask,
		getOrganization,
		getPersonnel,
		listAppointments,
		getMetrics,
		listFindings,
		getFinding,
		listRectifications,
		listRiskEvents,
		getAmlFacts,
		prepareFactPack,
		generateDraft,
		reviseDraft,
	];
}

/** Bind one immutable source dataset and one mutable drafting context to a single runtime/toolset. */
export function createBoundAuditReportTools(dataset: AuditReportDataset, skillRoot: string): ToolDefinition[] {
	const context = createAuditReportRequestContext(dataset);
	return createAuditReportTools(skillRoot).map((tool) => ({
		...tool,
		execute: async (...args: Parameters<typeof tool.execute>) =>
			await withAuditReportRequestContext(context, () => tool.execute(...args)),
	}));
}
