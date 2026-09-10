import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ReportDocumentNode } from "../audit-report/report-java-contract.ts";
import type {
	SupervisionAccountabilityRecord,
	SupervisionAnalysisResult,
	SupervisionRectificationRecord,
	SupervisionSourceType,
} from "./contracts.ts";
import { isBusinessDate } from "./dates.ts";
import { createMaterialSnapshot } from "./snapshot.ts";
import { parseSupervisionTask } from "./task.ts";

export interface SupervisionParagraphSources {
	documentVersionIds: string[];
	issueIds: string[];
	rectificationRecordIds: string[];
	accountabilityRecordIds: string[];
}

export interface SupervisionReportRecords {
	rectifications: readonly SupervisionRectificationRecord[];
	accountabilities: readonly SupervisionAccountabilityRecord[];
}

export interface SupervisionReportCitation {
	citationId: string;
	title: string;
	sourceType: SupervisionSourceType;
	documentId: string;
	documentVersionId: string;
}

export interface SupervisionParagraphLineage extends SupervisionParagraphSources {
	nodeId: string;
	evidenceIds: string[];
}

export interface SupervisionReportDocument {
	schemaVersion: "supervision-report-document.v1";
	taskId: string;
	snapshotAt: string;
	structureHash: string;
	contentHash: string;
	nodes: (ReportDocumentNode & { citationStatus?: "LINKED" | "NO_SOURCE" })[];
	citations: SupervisionReportCitation[];
	lineage: SupervisionParagraphLineage[];
}

interface LayoutItem {
	nodeId: string;
	parentId?: string;
	nodeType?: "heading";
	text?: string;
	styleRef?: string;
	field?: string;
	themes?: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function ids(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return [...new Set(value.map((item) => text(item, name)))];
}

function keyed<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
	const result = new Map<string, T>();
	for (const item of items) {
		const id = text(key(item), "source identifier");
		if (result.has(id)) throw new Error(`Duplicate source identifier: ${id}`);
		result.set(id, item);
	}
	return result;
}

function hash(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Builds display references only from identifiers explicitly supplied for each prose block. */
export async function buildSupervisionReportDocument(input: {
	analysis: SupervisionAnalysisResult;
	narrative: unknown;
	records: SupervisionReportRecords;
}): Promise<SupervisionReportDocument> {
	const { analysis, records } = input;
	const task = parseSupervisionTask(analysis.task);
	if (analysis.schemaVersion !== "supervision-analysis.v1" || analysis.task.taskId !== analysis.snapshot.taskId) {
		throw new Error("Invalid supervision analysis or mismatched snapshot taskId");
	}
	const narrative = object(input.narrative, "narrative");
	if (narrative.schemaVersion !== "supervision-report-narrative.v2") {
		throw new Error("narrative schemaVersion must be supervision-report-narrative.v2");
	}
	const sourceMap = object(narrative.paragraphSources, "narrative.paragraphSources");
	const checkedSnapshot = createMaterialSnapshot({
		task,
		snapshotAt: analysis.snapshot.snapshotAt,
		materials: analysis.snapshot.included,
	});
	if (checkedSnapshot.excluded.length > 0) {
		throw new Error(
			`Material outside task scope: ${checkedSnapshot.excluded[0]!.documentVersionId}:${checkedSnapshot.excluded[0]!.reason}`,
		);
	}
	const materials = keyed(analysis.snapshot.included, (item) => item.documentVersionId);
	for (const material of materials.values()) {
		if (material.processingStatus !== "indexed" || !material.organizationIds.includes(analysis.task.organizationId)) {
			throw new Error(`Material outside indexed task scope: ${material.documentVersionId}`);
		}
		text(material.title, "material.title");
	}
	const issues = keyed(analysis.issues, (item) => item.issueId);
	const rectifications = keyed(records.rectifications, (item) => item.recordId);
	const accountabilities = keyed(records.accountabilities, (item) => item.recordId);
	const isConfirmed = (status: string) => status === "AUTO_CONFIRMED" || status === "HUMAN_CONFIRMED";
	const getIssue = (id: string) => {
		const issue = issues.get(id);
		if (
			!issue ||
			!isConfirmed(issue.confirmationStatus) ||
			!issue.organizationIds.includes(analysis.task.organizationId)
		) {
			throw new Error(`Unknown, unconfirmed or out-of-scope issue: ${id}`);
		}
		const material = materials.get(issue.sourceDocumentVersionId);
		if (!material || material.documentId !== issue.sourceDocumentId) {
			throw new Error(`Issue document version is outside snapshot: ${id}`);
		}
		const discoveredDate = issue.discoveredDate ?? material.fileDate;
		if (!isBusinessDate(discoveredDate) || discoveredDate < task.analysisStart || discoveredDate > task.analysisEnd) {
			throw new Error(`Issue outside analysis period: ${id}`);
		}
		return issue;
	};
	const nodes: SupervisionReportDocument["nodes"] = [];
	const citations = new Map<string, SupervisionReportCitation>();
	const lineage: SupervisionParagraphLineage[] = [];
	const nodeIds = new Set<string>();
	const consumedSources = new Set<string>();
	const addNode = (node: Omit<SupervisionReportDocument["nodes"][number], "order">) => {
		if (nodeIds.has(node.nodeId)) throw new Error(`Duplicate report node: ${node.nodeId}`);
		if (node.parentId && !nodeIds.has(node.parentId)) throw new Error(`Unknown parent: ${node.parentId}`);
		nodeIds.add(node.nodeId);
		nodes.push({ ...node, order: nodes.length });
	};
	const addParagraph = (
		nodeId: string,
		parentId: string,
		value: unknown,
		sourceKey: string,
		themeIssueIds: string[] = [],
	) => {
		const sources = object(sourceMap[sourceKey], `paragraphSources.${sourceKey}`);
		const keys = ["documentVersionIds", "issueIds", "rectificationRecordIds", "accountabilityRecordIds"] as const;
		for (const key of Object.keys(sources)) {
			if (!(keys as readonly string[]).includes(key)) throw new Error(`Unknown source field: ${sourceKey}.${key}`);
		}
		const refs: SupervisionParagraphSources = {
			documentVersionIds: ids(sources.documentVersionIds, `${sourceKey}.documentVersionIds`),
			issueIds: ids(sources.issueIds, `${sourceKey}.issueIds`),
			rectificationRecordIds: ids(sources.rectificationRecordIds, `${sourceKey}.rectificationRecordIds`),
			accountabilityRecordIds: ids(sources.accountabilityRecordIds, `${sourceKey}.accountabilityRecordIds`),
		};
		for (const id of themeIssueIds) {
			if (!refs.issueIds.includes(id))
				throw new Error(`Theme issue is missing from paragraph sources: ${sourceKey}:${id}`);
		}
		consumedSources.add(sourceKey);
		const usedVersions = new Set<string>();
		const evidenceIds = new Set<string>();
		const citeMaterial = (versionId: string) => {
			const material = materials.get(versionId);
			if (!material) throw new Error(`Citation document version is outside snapshot: ${versionId}`);
			usedVersions.add(versionId);
			const citationId = `document:${versionId}`;
			citations.set(citationId, {
				citationId,
				title: material.title,
				sourceType: material.sourceType,
				documentId: material.documentId,
				documentVersionId: material.documentVersionId,
			});
		};
		for (const versionId of refs.documentVersionIds) citeMaterial(versionId);
		for (const id of refs.issueIds) {
			const issue = getIssue(id);
			citeMaterial(issue.sourceDocumentVersionId);
			for (const evidenceId of issue.evidenceIds) evidenceIds.add(evidenceId);
		}
		const citeRecords = (
			recordIds: string[],
			lookup: ReadonlyMap<string, SupervisionRectificationRecord | SupervisionAccountabilityRecord>,
			relationType: "RECTIFICATION" | "ACCOUNTABILITY",
		) => {
			for (const id of recordIds) {
				const record = lookup.get(id);
				if (!record) throw new Error(`Unknown ${relationType} record: ${id}`);
				if (record.confirmationStatus === "PENDING_REVIEW") throw new Error(`Unverified record: ${id}`);
				const relations = analysis.relations.filter(
					(relation) =>
						relation.relationType === relationType &&
						relation.selectedRecordId === id &&
						isConfirmed(relation.status),
				);
				const standalone =
					relationType === "ACCOUNTABILITY" &&
					record.confirmationStatus !== undefined &&
					isConfirmed(record.confirmationStatus) &&
					record.organizationIds.includes(task.organizationId);
				if (relations.length === 0 && !standalone)
					throw new Error(`Record has no confirmed ${relationType} relation: ${id}`);
				for (const relation of relations) getIssue(relation.issueId);
				// If no version is supplied, the document must resolve uniquely within the snapshot.
				const versions = [...materials.values()].filter(
					(material) =>
						material.documentId === record.sourceDocumentId &&
						(record.sourceDocumentVersionId === undefined ||
							record.sourceDocumentVersionId === material.documentVersionId),
				);
				if (versions.length !== 1)
					throw new Error(`Record must resolve to exactly one snapshot document version: ${id}`);
				const asOfDate = record.asOfDate ?? versions[0]!.fileDate;
				if (!isBusinessDate(asOfDate) || asOfDate < task.analysisStart || asOfDate > task.analysisEnd) {
					throw new Error(`Record outside analysis period: ${id}`);
				}
				citeMaterial(versions[0]!.documentVersionId);
				for (const evidenceId of record.evidenceIds) evidenceIds.add(evidenceId);
			}
		};
		citeRecords(refs.rectificationRecordIds, rectifications, "RECTIFICATION");
		citeRecords(refs.accountabilityRecordIds, accountabilities, "ACCOUNTABILITY");
		const citationIds = [...usedVersions].sort().map((id) => `document:${id}`);
		addNode({
			nodeId,
			nodeType: "paragraph",
			parentId,
			text: text(value, sourceKey),
			styleRef: "report.paragraph.body",
			textEditable: true,
			citationIds,
			citationStatus: citationIds.length ? "LINKED" : "NO_SOURCE",
			requiresHumanReview: citationIds.length === 0,
		});
		lineage.push({
			...refs,
			nodeId,
			documentVersionIds: [...usedVersions].sort(),
			evidenceIds: [...evidenceIds].sort(),
		});
	};
	addNode({
		nodeId: "title",
		nodeType: "title",
		text: "监督信息汇总分析报告",
		styleRef: "report.title",
		textEditable: false,
		citationIds: [],
		requiresHumanReview: false,
	});
	const layout = JSON.parse(
		await readFile(new URL("../../specs/supervision-analysis/report-layout.json", import.meta.url), "utf8"),
	) as LayoutItem[];
	for (const item of layout) {
		if (item.field) {
			addParagraph(item.nodeId, item.parentId!, narrative[item.field], item.field);
		} else if (item.themes) {
			const themes = narrative[item.themes];
			if (!Array.isArray(themes)) throw new Error(`${item.themes} must be an array`);
			for (const [index, value] of themes.entries()) {
				const theme = object(value, `${item.themes}.${index}`);
				const issueIds = ids(theme.issueIds, `${item.themes}.${index}.issueIds`);
				if (!issueIds.length) throw new Error("A report theme must identify its issues");
				for (const id of issueIds) {
					const issue = getIssue(id);
					const allowed =
						item.themes === "regulatoryIssues"
							? ["external.regulatory"]
							: ["internal.audit", "internal.compliance", "internal.risk"];
					if (!allowed.includes(issue.reportSection))
						throw new Error(`Issue is in the wrong report section: ${id}`);
				}
				const themeId = `${item.themes}:${hash([...issueIds].sort()).slice(7, 23)}`;
				addNode({
					nodeId: themeId,
					parentId: item.parentId,
					nodeType: "heading",
					text: `${index + 1}.${text(theme.title, "theme.title")}`,
					styleRef: "report.heading.item",
					textEditable: false,
					citationIds: [],
					requiresHumanReview: false,
				});
				addParagraph(`${themeId}:body`, themeId, theme.analysis, `${item.themes}.${index}.analysis`, issueIds);
			}
		} else {
			addNode({
				nodeId: item.nodeId,
				...(item.parentId ? { parentId: item.parentId } : {}),
				nodeType: "heading",
				text: item.text!,
				styleRef: item.styleRef!,
				textEditable: false,
				citationIds: [],
				requiresHumanReview: false,
			});
		}
	}
	for (const key of Object.keys(sourceMap)) {
		if (!consumedSources.has(key)) throw new Error(`Orphan paragraph source entry: ${key}`);
	}
	addNode({
		nodeId: "task-metadata",
		parentId: "appendix",
		nodeType: "paragraph",
		text: `被分析单位：${task.organizationId}。分析期间：${task.analysisStart}至${task.analysisEnd}。`,
		styleRef: "report.paragraph.metadata",
		textEditable: false,
		citationIds: [],
		requiresHumanReview: false,
	});
	const citationList = [...citations.values()].sort((a, b) => a.citationId.localeCompare(b.citationId));
	return {
		schemaVersion: "supervision-report-document.v1",
		taskId: analysis.task.taskId,
		snapshotAt: analysis.snapshot.snapshotAt,
		structureHash: hash(
			nodes.map(({ nodeId, parentId, nodeType, order, styleRef }) => ({
				nodeId,
				parentId,
				nodeType,
				order,
				styleRef,
			})),
		),
		contentHash: hash({
			taskId: analysis.task.taskId,
			snapshotAt: analysis.snapshot.snapshotAt,
			nodes,
			citations: citationList,
			lineage,
		}),
		nodes,
		citations: citationList,
		lineage,
	};
}
