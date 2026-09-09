import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AuditReportDataset,
	DataSourceDefinition,
	EvidenceRecord,
	ReportDraft,
	ReportParagraph,
	ReportTable,
} from "./report-contracts.ts";

export type ReportDocumentNodeType =
	| "title"
	| "addressee"
	| "heading"
	| "paragraph"
	| "table"
	| "closing-organization"
	| "report-date";

export interface ReportDocumentNode {
	nodeId: string;
	nodeType: ReportDocumentNodeType;
	parentId?: string;
	order: number;
	text: string;
	styleRef: string;
	textEditable: boolean;
	citationIds: readonly string[];
	requiresHumanReview: boolean;
	basis?: ReportNodeBasis;
}

export interface ReportNodeBasis {
	kind: "business-record" | "template" | "missing";
	textHash: string;
	template?: { templateId: string; templateVersion: string; paragraphId: string };
	sourceGroups: Array<{
		sourceId: string;
		sourceName: string;
		sourceRecordId: string;
		asOf: string;
		dataVersion: string;
		citationIds: string[];
	}>;
}

export function reportTextHash(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** An edit invalidates applicability, not the historical source itself. */
export function reportBasisNeedsRecheck(node: ReportDocumentNode, editedText: string): boolean {
	return !node.basis || node.basis.textHash !== reportTextHash(editedText);
}

/** Compare JSON values, ignoring object key order, but not array order or any field. */
export function reportDocumentMatches(expected: AuditReportJavaDocument, candidate: unknown): boolean {
	return isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), candidate);
}

export interface ReportCitation {
	citationId: string;
	title: string;
	summary: string;
	sourceType: "business-record";
	source: {
		sourceId: string;
		sourceName: string;
		sourceRecordId: string;
		sourceField: string;
		authority: DataSourceDefinition["authority"] | "unknown";
		sourceCatalogRegistered: boolean;
	};
	lineage: {
		mode: "direct-field";
		evidenceIds: readonly string[];
	};
	asOf: string;
	dataVersion: string;
}

export interface AuditReportJavaDocument {
	schemaVersion: "audit-report-document.v1";
	structureHash: string;
	report: ReportDraft;
	nodes: readonly ReportDocumentNode[];
	citations: readonly ReportCitation[];
}

interface NodeInput {
	nodeId: string;
	nodeType: ReportDocumentNodeType;
	parentId?: string;
	text: string;
	styleRef: string;
	textEditable?: boolean;
	citationIds?: readonly string[];
	requiresHumanReview?: boolean;
}

function citationFor(evidence: EvidenceRecord, source: DataSourceDefinition | undefined): ReportCitation {
	const sourceName = source?.name ?? `未登记数据源（${evidence.sourceId}）`;
	return {
		citationId: evidence.evidenceId,
		title: `${sourceName} · ${evidence.sourceRecordId}`,
		summary: evidence.normalizedValue,
		sourceType: "business-record",
		source: {
			sourceId: evidence.sourceId,
			sourceName,
			sourceRecordId: evidence.sourceRecordId,
			sourceField: evidence.sourceField,
			authority: source?.authority ?? "unknown",
			sourceCatalogRegistered: source !== undefined,
		},
		lineage: {
			mode: "direct-field",
			evidenceIds: [evidence.evidenceId],
		},
		asOf: evidence.asOf,
		dataVersion: evidence.dataVersion,
	};
}

export function toAuditReportJavaDocument(dataset: AuditReportDataset, report: ReportDraft): AuditReportJavaDocument {
	const nodes: ReportDocumentNode[] = [];
	const nodeIds = new Set<string>();
	let order = 0;
	const addNode = (input: NodeInput): void => {
		if (nodeIds.has(input.nodeId)) throw new Error(`Duplicate report node ID: ${input.nodeId}`);
		nodeIds.add(input.nodeId);
		nodes.push({
			nodeId: input.nodeId,
			nodeType: input.nodeType,
			...(input.parentId === undefined ? {} : { parentId: input.parentId }),
			order: order++,
			text: input.text,
			styleRef: input.styleRef,
			textEditable: input.textEditable ?? false,
			citationIds: [...(input.citationIds ?? [])],
			requiresHumanReview: input.requiresHumanReview ?? false,
		});
	};
	const addParagraph = (paragraph: ReportParagraph, parentId?: string): void => {
		addNode({
			nodeId: paragraph.paragraphId,
			nodeType: "paragraph",
			...(parentId === undefined ? {} : { parentId }),
			text: paragraph.text,
			styleRef: "report.paragraph.body",
			textEditable: true,
			citationIds: paragraph.evidenceIds,
			requiresHumanReview: paragraph.requiresHumanReview,
		});
	};
	const addTable = (table: ReportTable, parentId: string): void => {
		addNode({
			nodeId: `table:${table.tableId}`,
			nodeType: "table",
			parentId,
			text: table.title,
			styleRef: "report.table",
			citationIds: table.sourceEvidenceIds,
		});
	};

	for (const [index, title] of report.titleLines.entries()) {
		addNode({
			nodeId: `title-${index + 1}`,
			nodeType: "title",
			text: title,
			styleRef: `report.title.${index + 1}`,
		});
	}
	if (report.addressee !== undefined) {
		addNode({
			nodeId: "addressee",
			nodeType: "addressee",
			text: report.addressee,
			styleRef: "report.addressee",
		});
	}
	addParagraph(report.introduction);

	for (const [sectionIndex, section] of report.sections.entries()) {
		const sectionId = `section-${sectionIndex + 1}`;
		addNode({
			nodeId: sectionId,
			nodeType: "heading",
			text: section.heading,
			styleRef: "report.heading.section",
		});
		for (const paragraph of section.paragraphs) addParagraph(paragraph, sectionId);
		for (const table of section.tables) addTable(table, sectionId);
		for (const [subsectionIndex, subsection] of section.subsections.entries()) {
			const subsectionId = `${sectionId}-subsection-${subsectionIndex + 1}`;
			addNode({
				nodeId: subsectionId,
				nodeType: "heading",
				parentId: sectionId,
				text: subsection.heading,
				styleRef: "report.heading.subsection",
			});
			const tablesAfter = subsection.tablesAfterParagraphCount ?? subsection.paragraphs.length;
			for (const [paragraphIndex, paragraph] of subsection.paragraphs.entries()) {
				if (paragraphIndex === tablesAfter) {
					for (const table of subsection.tables ?? []) addTable(table, subsectionId);
				}
				addParagraph(paragraph, subsectionId);
			}
			if (tablesAfter >= subsection.paragraphs.length) {
				for (const table of subsection.tables ?? []) addTable(table, subsectionId);
			}
		}
		for (const paragraph of section.closingParagraphs ?? []) addParagraph(paragraph, sectionId);
	}

	addNode({
		nodeId: "closing-organization",
		nodeType: "closing-organization",
		text: report.closingOrganization,
		styleRef: "report.closing.organization",
	});
	addNode({
		nodeId: "report-date",
		nodeType: "report-date",
		text: report.reportDate,
		styleRef: "report.closing.date",
	});

	const evidenceById = new Map(dataset.evidence.map((item) => [item.evidenceId, item]));
	if (evidenceById.size !== dataset.evidence.length) throw new Error("Duplicate evidence IDs in source snapshot");
	const sourceById = new Map(dataset.sources.map((item) => [item.sourceId, item]));
	if (sourceById.size !== dataset.sources.length) throw new Error("Duplicate source IDs in source snapshot");
	const citedEvidenceIds = [...new Set(nodes.flatMap((node) => node.citationIds))];
	const citations = citedEvidenceIds.map((evidenceId) => {
		const evidence = evidenceById.get(evidenceId);
		if (!evidence) throw new Error(`Report cites unknown evidence ID: ${evidenceId}`);
		const source = sourceById.get(evidence.sourceId);
		return citationFor(evidence, source);
	});
	const citationById = new Map(citations.map((citation) => [citation.citationId, citation]));
	for (const node of nodes) {
		if (node.nodeType !== "paragraph" && node.nodeType !== "table") continue;
		const groups = new Map<string, ReportNodeBasis["sourceGroups"][number]>();
		for (const id of new Set(node.citationIds)) {
			const citation = citationById.get(id);
			if (!citation) throw new Error(`Unresolved citation: ${id}`);
			const { sourceId, sourceName, sourceRecordId } = citation.source;
			const { asOf, dataVersion } = citation;
			const key = JSON.stringify([sourceId, sourceRecordId, asOf, dataVersion]);
			const group = groups.get(key) ?? { sourceId, sourceName, sourceRecordId, asOf, dataVersion, citationIds: [] };
			group.citationIds.push(id);
			groups.set(key, group);
		}
		// Only explicit template slots qualify; empty references alone never imply template text.
		const templateOnly =
			/^(?:attachment-)?opinion-\d+$/.test(node.nodeId) ||
			[
				"regular-opinion-lead",
				"regular-final-rectification",
				"attachment-aml-opinion-lead",
				"attachment-aml-final-rectification",
			].includes(node.nodeId);
		node.basis = {
			kind: groups.size ? "business-record" : templateOnly ? "template" : "missing",
			textHash: reportTextHash(node.text),
			...(templateOnly && !groups.size
				? {
						template: {
							templateId: report.templateId,
							templateVersion: report.templateVersion,
							paragraphId: node.nodeId,
						},
					}
				: {}),
			sourceGroups: [...groups.values()],
		};
	}
	const immutableStructure = {
		templateId: report.templateId,
		templateVersion: report.templateVersion,
		nodes: nodes.map(({ nodeId, nodeType, parentId, order: nodeOrder, styleRef }) => ({
			nodeId,
			nodeType,
			...(parentId === undefined ? {} : { parentId }),
			order: nodeOrder,
			styleRef,
		})),
	};

	return {
		schemaVersion: "audit-report-document.v1",
		structureHash: `sha256:${createHash("sha256").update(JSON.stringify(immutableStructure)).digest("hex")}`,
		report,
		nodes,
		citations,
	};
}
