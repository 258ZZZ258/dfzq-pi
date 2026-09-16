import { readFileSync } from "node:fs";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildSupervisionAnalysisResult } from "../src/supervision-analysis/result.ts";
import { scopeSupervisionAnalysisPayload } from "../src/supervision-analysis/snapshot.ts";
import {
	parseSupervisionUploadedMaterial,
	type SupervisionUploadedMaterial,
	toSupervisionMaterialsFromUploads,
} from "../src/supervision-analysis/upload-material-adapter.ts";
import { parseSupervisionAnalysisPayload } from "../src/toolsets/supervision-analysis.ts";

const mappings = [{ categoryCode: "TEST_REG", sourceType: "regulatory" }];
function upload(overrides: Partial<SupervisionUploadedMaterial> = {}): SupervisionUploadedMaterial {
	return {
		documentId: "DOC-1",
		documentVersionId: "DOC-1-V1",
		fileName: "监管函.pdf",
		title: "监管检查函",
		issueDate: "2026-06-30",
		categoryCode: "TEST_REG",
		documentOrigin: "external",
		organizationIds: ["ORG-1", "ORG-2"],
		uploadDepartmentId: "RISK",
		uploadedAt: "2026-09-04T10:00:00+08:00",
		uploadEntry: "supervision",
		processingStatus: "indexed",
		parseVersion: "parse-1",
		indexVersion: "index-1",
		...overrides,
	};
}
function input(uploads: unknown[] = [upload()]) {
	return {
		task: { taskId: "TASK-1", organizationId: "ORG-1", analysisStart: "2026-01-01", analysisEnd: "2026-06-30" },
		snapshotAt: "2026-09-04T10:00:00+08:00",
		uploadedMaterials: uploads,
		categoryMappings: mappings,
		issues: [],
		rectifications: [],
		accountabilities: [],
	};
}

describe("Java upload metadata to supervision analysis", () => {
	it("uses supplied organization, date and category rather than uploader or upload time", () => {
		const payload = parseSupervisionAnalysisPayload(input());
		const scope = scopeSupervisionAnalysisPayload(payload);
		expect(scope.snapshot.included).toHaveLength(1);
		expect(scope.snapshot.included[0]).toMatchObject({
			sourceType: "regulatory",
			fileDate: "2026-06-30",
			organizationIds: ["ORG-1", "ORG-2"],
		});
		expect(payload).not.toHaveProperty("uploadedMaterials");
		expect(payload).not.toHaveProperty("categoryMappings");
		expect(payload.materials[0]).not.toHaveProperty("uploadDepartmentId");
		const result = buildSupervisionAnalysisResult({ task: payload.task, ...scope, relations: [] });
		const schema: unknown = JSON.parse(
			readFileSync(new URL("../specs/supervision-analysis/output-contract.schema.json", import.meta.url), "utf8"),
		);
		expect(Value.Check(schema as never, result)).toBe(true);
	});

	it.each([
		[undefined, "MISSING_FILE_DATE"],
		["", "MISSING_FILE_DATE"],
		["2026-02-30", "INVALID_FILE_DATE"],
		["2026-07-01", "OUTSIDE_ANALYSIS_PERIOD"],
	])("keeps date %s as a scope exclusion without using upload time", (issueDate, reason) => {
		const scope = scopeSupervisionAnalysisPayload(
			parseSupervisionAnalysisPayload(
				input([upload(), upload({ documentId: "DOC-2", documentVersionId: "DOC-2-V1", issueDate })]),
			),
		);
		expect(scope.snapshot.included).toHaveLength(1);
		expect(scope.snapshot.excluded[0]?.reason).toBe(reason);
	});

	it("excludes unprocessed versions without requiring invented parse/index versions", () => {
		const scope = scopeSupervisionAnalysisPayload(
			parseSupervisionAnalysisPayload(
				input([upload({ processingStatus: "processing", parseVersion: undefined, indexVersion: undefined })]),
			),
		);
		expect(scope.snapshot.included).toEqual([]);
		expect(scope.snapshot.excluded[0]?.reason).toBe("processing");
	});

	it("never substitutes uploader department for missing organization", () => {
		const scope = scopeSupervisionAnalysisPayload(
			parseSupervisionAnalysisPayload(input([upload({ organizationIds: [], uploadDepartmentId: "ORG-1" })])),
		);
		expect(scope.snapshot.excluded[0]?.reason).toBe("ORGANIZATION_NOT_MATCHED");
	});

	it("uses filename for empty title and copies normalized organization IDs", () => {
		const original = upload({ title: "  ", organizationIds: [" ORG-1 ", "ORG-1"] });
		const [material] = toSupervisionMaterialsFromUploads([original], mappings);
		expect(material?.title).toBe("监管函.pdf");
		expect(material?.organizationIds).toEqual(["ORG-1"]);
		expect(original.organizationIds).toEqual([" ORG-1 ", "ORG-1"]);
	});

	it("resolves internal/external category mapping explicitly", () => {
		const categoryMappings = [
			{ categoryCode: "TEST_REG", documentOrigin: "internal", sourceType: "compliance" },
			{ categoryCode: "TEST_REG", documentOrigin: "external", sourceType: "regulatory" },
		];
		expect(toSupervisionMaterialsFromUploads([upload()], categoryMappings)[0]?.sourceType).toBe("regulatory");
		expect(() => toSupervisionMaterialsFromUploads([upload()], [...categoryMappings, ...mappings])).toThrow(
			"exactly one mapping",
		);
	});

	it("rejects unknown categories and unsupported mapping fields rather than guessing", () => {
		expect(() => toSupervisionMaterialsFromUploads([upload({ categoryCode: "UNKNOWN" })], mappings)).toThrow(
			"found 0",
		);
		expect(() =>
			toSupervisionMaterialsFromUploads([upload()], [{ ...mappings[0], uploadDepartmentId: "RISK" }]),
		).toThrow("Invalid supervision category mapping");
		expect(() =>
			toSupervisionMaterialsFromUploads([upload()], [{ categoryCode: "TEST_REG", sourceType: "bogus" }]),
		).toThrow("Invalid supervision category mapping");
	});

	it("requires complete version identity for indexed uploads and rejects duplicate versions", () => {
		expect(() => parseSupervisionUploadedMaterial(upload({ indexVersion: undefined }))).toThrow(
			"requires parseVersion",
		);
		expect(() => toSupervisionMaterialsFromUploads([upload(), upload()], mappings)).toThrow(
			"Duplicate uploaded documentVersionId",
		);
	});

	it("rejects malformed metadata and source-system fields", () => {
		expect(() => parseSupervisionUploadedMaterial({ ...upload(), organizationIds: "ORG-1" })).toThrow(
			"Invalid supervision upload metadata",
		);
		expect(() => parseSupervisionUploadedMaterial({ ...upload(), sourceRecordId: "SOURCE-1" })).toThrow(
			"Invalid supervision upload metadata",
		);
		expect(() => parseSupervisionUploadedMaterial(upload({ indexVersion: " " }))).toThrow(
			"Invalid supervision upload metadata",
		);
	});

	it("rejects ambiguous input paths and missing category configuration", () => {
		expect(() => parseSupervisionAnalysisPayload({ ...input(), materials: [] })).toThrow("not both");
		expect(() => parseSupervisionAnalysisPayload({ ...input(), categoryMappings: undefined })).toThrow(
			"categoryMappings",
		);
		const { uploadedMaterials: _uploads, ...remaining } = input();
		expect(() => parseSupervisionAnalysisPayload({ ...remaining, materials: [] })).toThrow(
			"requires uploadedMaterials",
		);
	});
});
