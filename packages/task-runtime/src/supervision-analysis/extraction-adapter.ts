import { createHash } from "node:crypto";
import { classifyIssue } from "./classification.ts";
import type { RectificationStatus, SupervisionAnalysisPayload } from "./contracts.ts";
import { isBusinessDate } from "./dates.ts";
import { findSupervisionExtractionRule } from "./rules.ts";
import { parseSupervisionUploadedMaterial, toSupervisionMaterialsFromUploads } from "./upload-material-adapter.ts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extraction object");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Invalid extraction text");
	return value;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Invalid extraction array");
	return value;
}

const statuses: Readonly<Record<string, RectificationStatus>> = {
	未开始: "NOT_STARTED",
	进行中: "IN_PROGRESS",
	整改中: "IN_PROGRESS",
	部分完成: "PARTIALLY_COMPLETED",
	完成: "COMPLETED",
	已完成: "COMPLETED",
	持续整改: "CONTINUOUS",
	逾期: "OVERDUE",
	无法整改: "UNABLE",
};

export interface FieldCheck {
	id: string;
	field: string;
	value: string;
	evidence: string;
}

/** Trusted internal extraction response -> validated business records; never model-supplied confirmation. */
export function convertSupervisionExtractions(
	results: unknown,
	mappings: unknown,
	verified?: ReadonlyMap<string, boolean>,
	checks?: FieldCheck[],
	verificationReasons?: ReadonlyMap<string, string>,
): Pick<SupervisionAnalysisPayload, "materials" | "issues" | "rectifications" | "accountabilities"> {
	const outputs = array(results).map(object);
	const uploads = outputs.map((output) => parseSupervisionUploadedMaterial(output.uploadedMaterial));
	const materials = toSupervisionMaterialsFromUploads(uploads, mappings);
	const issues: SupervisionAnalysisPayload["issues"][number][] = [];
	const rectifications: SupervisionAnalysisPayload["rectifications"][number][] = [];
	const accountabilities: SupervisionAnalysisPayload["accountabilities"][number][] = [];
	for (const [index, output] of outputs.entries()) {
		const material = materials[index]!;
		if (
			output.schemaVersion !== "supervision-extraction.v1" ||
			output.extractionStatus !== "EXTRACTED" ||
			material.processingStatus !== "indexed"
		)
			throw new Error("Extraction is not ready");
		const evidence = new Map<string, string>();
		for (const raw of array(output.evidence)) {
			const item = object(raw);
			const id = string(item.evidenceId);
			if (
				evidence.has(id) ||
				item.documentId !== material.documentId ||
				item.documentVersionId !== material.documentVersionId
			)
				throw new Error("Extraction evidence version mismatch or duplicate");
			evidence.set(id, string(item.text));
		}
		const seen = new Set<string>();
		for (const raw of array(output.facts)) {
			const fact = object(raw);
			const factId = string(fact.factId);
			if (seen.has(factId)) throw new Error("Duplicate extracted fact");
			seen.add(factId);
			const rule = findSupervisionExtractionRule(string(fact.ruleId));
			if (!rule || rule.reportSection !== fact.reportSection || !rule.sourceTypes.includes(material.sourceType))
				throw new Error("Extraction rule mismatch");
			const organizationIds = array(fact.organizationIds).map(string);
			if (!organizationIds.length || organizationIds.some((id) => !material.organizationIds.includes(id)))
				throw new Error("Extraction organization mismatch");
			const values: Record<string, string> = {};
			const evidenceIds = new Set<string>();
			const supported = new Set<string>();
			const reviewReasons: string[] = [];
			for (const [key, rawValue] of Object.entries(object(fact.values))) {
				if (!rule.extractFields.some((field) => field.key === key)) throw new Error("Unknown extraction field");
				const value = object(rawValue);
				values[key] = string(value.value);
				const contexts = new Set<string>();
				for (const rawCitation of [value, ...array(value.supportingEvidence ?? [])]) {
					const citation = object(rawCitation);
					const id = string(citation.evidenceId);
					if (!evidence.get(id)?.includes(string(citation.quote))) throw new Error("Invalid extraction quote");
					evidenceIds.add(id);
					// Exact values are a conservative local gate; summaries require upstream semantic verification.
					const source = evidence.get(id)!;
					contexts.add(source);
					const quote = string(citation.quote);
					const position = source.indexOf(quote);
					if (
						quote.trim() === values[key]!.trim() &&
						!/[未不无非]$/u.test(source.slice(Math.max(0, position - 1), position))
					)
						supported.add(key);
				}
				if (key !== "evidenceLocation") {
					const context = [...contexts].join("\n\n");
					const id = createHash("sha256")
						.update(JSON.stringify([material.documentVersionId, factId, key, values[key], context]))
						.digest("hex");
					checks?.push({ id, field: key, value: values[key]!, evidence: context });
					if (verified !== undefined) {
						supported.delete(key);
						if (verified.get(id) === true) supported.add(key);
						else reviewReasons.push(`${key}: ${verificationReasons?.get(id) ?? "原文证据不足"}`);
					}
				}
			}
			const missing = rule.extractFields.filter((field) => field.required && !values[field.key]);
			const description =
				values.issueDescription ?? values.specificMatter ?? values.relatedMatter ?? values.caseFacts;
			const dateMatch = /^(\d{4})(?:-|年)(\d{1,2})(?:-|月)(\d{1,2})日?$/u.exec(values.documentDate ?? "");
			const documentDate = dateMatch
				? `${dateMatch[1]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`
				: undefined;
			const dateValid =
				!rule.extractFields.some((f) => f.key === "documentDate" && f.required) ||
				(isBusinessDate(documentDate) && documentDate === material.fileDate);
			const dateWarning = array(output.metadataChecks ?? []).some((check) =>
				["INVALID_ISSUE_DATE", "MISSING_ISSUE_DATE", "DATE_NOT_FOUND_IN_TEXT"].includes(String(object(check).code)),
			);
			const grounded = Object.keys(values).every((key) => key === "evidenceLocation" || supported.has(key));
			const confirmed = missing.length === 0 && Boolean(description) && dateValid && !dateWarning && grounded;
			if (!dateValid || dateWarning) reviewReasons.push("发文日期缺失、无效或与资料不一致");
			if (!grounded && verified === undefined) reviewReasons.push("字段尚未完成语义核验");
			const explicitType = fact.factType ?? "UNSPECIFIED";
			if (
				!["FINDING", "RECTIFICATION", "ACCOUNTABILITY", "LITIGATION", "UNSPECIFIED"].includes(String(explicitType))
			)
				throw new Error("Invalid fact type");
			const progress = Boolean(
				values.rectificationMeasure || values.rectificationResult || values.rectificationStatus,
			);
			const type =
				explicitType === "UNSPECIFIED"
					? rule.reportSection === "internal.daily.litigation"
						? "LITIGATION"
						: values.accountabilityAction
							? "ACCOUNTABILITY"
							: progress
								? "RECTIFICATION"
								: "FINDING"
					: explicitType;
			const issueId = `EXTRACT-${createHash("sha256")
				.update(JSON.stringify([material.documentVersionId, factId]))
				.digest("hex")}`;
			const base = {
				sourceDocumentId: material.documentId,
				sourceDocumentVersionId: material.documentVersionId,
				organizationIds,
				responsibleDepartmentIds: [],
				evidenceIds: [...evidenceIds],
				dataOrigin: material.dataOrigin,
				reviewReasons,
			};
			if (type !== "RECTIFICATION" && type !== "ACCOUNTABILITY")
				issues.push({
					...base,
					reviewReasons: [...reviewReasons, ...missing.map((field) => `缺少必填字段: ${field.label}`)],
					issueId,
					extractionRuleId: rule.ruleId,
					reportSection: rule.reportSection,
					sourceType: material.sourceType,
					title: values.documentTitle ?? material.title,
					description: description ?? "缺少事项描述",
					category: classifyIssue(description ?? "", rule.issueCategoryHints),
					severity: "unknown",
					confirmationStatus: confirmed ? "AUTO_CONFIRMED" : "PENDING_REVIEW",
					fieldValues: values,
					requiresRectification: rule.extractFields.some((f) => f.key === "rectificationStatus"),
					requiresAccountability: type === "FINDING",
					...(values.documentNumber ? { documentNumber: values.documentNumber } : {}),
				});
			const linked = {
				...base,
				referencedIssueIds: type === "FINDING" && confirmed ? [issueId] : [],
				referencedDocumentNumbers: [],
				asOfDate: material.fileDate,
			};
			const recordValid =
				grounded && !dateWarning && isBusinessDate(material.fileDate) && (!values.documentDate || dateValid);
			if (!isBusinessDate(material.fileDate)) reviewReasons.push("资料缺少有效发文日期");
			if (progress) {
				rectifications.push({
					...linked,
					recordId: `${issueId}:RECT`,
					description: [
						description,
						values.rectificationMeasure,
						values.rectificationResult,
						values.rectificationStatus,
					]
						.filter(Boolean)
						.join("；"),
					status: statuses[values.rectificationStatus ?? ""] ?? "PENDING_REVIEW",
					confirmationStatus: recordValid ? "AUTO_CONFIRMED" : "PENDING_REVIEW",
				});
			}
			if (values.accountabilityAction)
				accountabilities.push({
					...linked,
					recordId: `${issueId}:ACC`,
					description: [description, values.accountabilityAction].filter(Boolean).join("；"),
					action: values.accountabilityAction,
					confirmationStatus: recordValid ? "AUTO_CONFIRMED" : "PENDING_REVIEW",
				});
		}
	}
	return { materials, issues, rectifications, accountabilities };
}
