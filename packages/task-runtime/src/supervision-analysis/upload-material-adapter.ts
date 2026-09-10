import { readFileSync } from "node:fs";
import { Value } from "typebox/value";
import type {
	MaterialProcessingStatus,
	SupervisionMaterial,
	SupervisionSourceType,
	SupervisionUploadEntry,
} from "./contracts.ts";
import { getSupervisionExtractionRules } from "./rules.ts";

/** Java's authorized projection of a locally uploaded attachment version, not a source-system record. */
export interface SupervisionUploadedMaterial {
	documentId: string;
	documentVersionId: string;
	fileName: string;
	title?: string;
	issueDate?: string;
	categoryCode: string;
	documentOrigin: "internal" | "external";
	organizationIds: readonly string[];
	uploadDepartmentId?: string;
	uploadedAt?: string;
	uploadEntry: SupervisionUploadEntry;
	processingStatus: MaterialProcessingStatus;
	parseVersion?: string;
	indexVersion?: string;
}

/** Backend category configuration. Never derive classification from uploader or file name. */
export interface SupervisionCategoryMapping {
	categoryCode: string;
	documentOrigin?: SupervisionUploadedMaterial["documentOrigin"];
	sourceType: SupervisionSourceType;
}

const uploadSchema: unknown = JSON.parse(
	readFileSync(new URL("../../specs/supervision-analysis/upload-material.schema.json", import.meta.url), "utf8"),
);
const sourceTypes = new Set(getSupervisionExtractionRules().flatMap((rule) => rule.sourceTypes));

export function parseSupervisionUploadedMaterial(value: unknown): SupervisionUploadedMaterial {
	if (!Value.Check(uploadSchema as never, value)) {
		throw new Error("Invalid supervision upload metadata; expected supervision-upload-material.v1");
	}
	const item = value as SupervisionUploadedMaterial;
	if (item.processingStatus === "indexed" && (!item.parseVersion || !item.indexVersion)) {
		throw new Error(`Indexed upload ${item.documentVersionId} requires parseVersion and indexVersion`);
	}
	return {
		...item,
		documentId: item.documentId.trim(),
		documentVersionId: item.documentVersionId.trim(),
		fileName: item.fileName.trim(),
		title: item.title?.trim(),
		issueDate: item.issueDate?.trim(),
		categoryCode: item.categoryCode.trim(),
		organizationIds: [...new Set(item.organizationIds.map((id) => id.trim()))],
	};
}

export function parseSupervisionCategoryMappings(value: unknown): SupervisionCategoryMapping[] {
	if (!Array.isArray(value)) throw new Error("categoryMappings must be an array of backend category mappings");
	return value.map((entry: unknown) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error("Invalid supervision category mapping");
		}
		const item = entry as Record<string, unknown>;
		if (
			Object.keys(item).some((key) => !["categoryCode", "documentOrigin", "sourceType"].includes(key)) ||
			typeof item.categoryCode !== "string" ||
			!item.categoryCode.trim() ||
			typeof item.sourceType !== "string" ||
			!sourceTypes.has(item.sourceType as SupervisionSourceType) ||
			(item.documentOrigin !== undefined && item.documentOrigin !== "internal" && item.documentOrigin !== "external")
		)
			throw new Error("Invalid supervision category mapping");
		return {
			categoryCode: item.categoryCode.trim(),
			sourceType: item.sourceType as SupervisionSourceType,
			...(item.documentOrigin === undefined ? {} : { documentOrigin: item.documentOrigin }),
		};
	});
}

/** Convert before the existing scope step; missing/invalid business dates remain scope exclusions. */
export function toSupervisionMaterialsFromUploads(uploads: unknown, mappings: unknown): SupervisionMaterial[] {
	if (!Array.isArray(uploads)) throw new Error("uploadedMaterials must be an array");
	const categories = parseSupervisionCategoryMappings(mappings);
	const seen = new Set<string>();
	return uploads.map((value: unknown) => {
		const item = parseSupervisionUploadedMaterial(value);
		if (seen.has(item.documentVersionId))
			throw new Error(`Duplicate uploaded documentVersionId: ${item.documentVersionId}`);
		seen.add(item.documentVersionId);
		const matches = categories.filter(
			(mapping) =>
				mapping.categoryCode === item.categoryCode &&
				(mapping.documentOrigin === undefined || mapping.documentOrigin === item.documentOrigin),
		);
		if (matches.length !== 1) {
			throw new Error(
				`Upload category ${item.categoryCode}/${item.documentOrigin} requires exactly one mapping; found ${matches.length}`,
			);
		}
		return {
			documentId: item.documentId,
			documentVersionId: item.documentVersionId,
			parseVersion: item.parseVersion?.trim() ?? "",
			indexVersion: item.indexVersion?.trim() ?? "",
			title: item.title || item.fileName,
			sourceType: matches[0]!.sourceType,
			uploadEntry: item.uploadEntry,
			processingStatus: item.processingStatus,
			dataOrigin: "internal",
			...(item.issueDate ? { fileDate: item.issueDate } : {}),
			organizationIds: item.organizationIds,
		};
	});
}
