import { afterEach, expect, it, vi } from "vitest";
import { associateSupervisionRecords } from "../src/supervision-analysis/association.ts";
import type { AssociateSupervisionRecordsInput } from "../src/supervision-analysis/contracts.ts";
import { type AssociationDecision, judgeAssociationCandidates } from "../src/supervision-analysis/judgement.ts";
import { computeAssociationScores, pairKey } from "../src/supervision-analysis/semantic.ts";

function input(): AssociateSupervisionRecordsInput {
	return {
		issues: ["I1", "I2"].map((issueId) => ({
			issueId,
			sourceDocumentId: "D",
			sourceDocumentVersionId: "V",
			evidenceIds: ["E"],
			extractionRuleId: "internal-audit-issue",
			reportSection: "internal.audit",
			sourceType: "internal-audit",
			title: issueId,
			description: issueId === "I1" ? "设备未登记" : "合同未审批",
			organizationIds: ["O"],
			responsibleDepartmentIds: [],
			category: "内控",
			severity: "low",
			confirmationStatus: "AUTO_CONFIRMED",
			requiresRectification: true,
			requiresAccountability: false,
			documentNumber: "审计〔2026〕1号",
			fieldValues: {},
		})),
		rectifications: [
			{
				recordId: "R",
				sourceDocumentId: "RD",
				evidenceIds: ["RE"],
				referencedIssueIds: [],
				referencedDocumentNumbers: ["审计〔2026〕1号"],
				organizationIds: ["O"],
				responsibleDepartmentIds: [],
				description: "已登记设备",
				status: "COMPLETED",
				semanticScore: 1,
			},
		],
		accountabilities: [],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function decision(issueId: string, verdict: AssociationDecision["verdict"]): AssociationDecision {
	return {
		pairId: pairKey(issueId, "R"),
		verdict,
		reason: "具体对象对应",
		issueQuote: issueId === "I1" ? "设备未登记" : "合同未审批",
		recordQuote: "已登记设备",
	};
}

it("automatically associates an evidence-supported match without IDs and rejects same-document unrelated issue", () => {
	const data = input();
	data.rectifications = data.rectifications.map((r) => ({ ...r, status: "IN_PROGRESS" }));
	const decisions = new Map([decision("I1", "MATCH"), decision("I2", "NO_MATCH")].map((d) => [d.pairId, d]));
	const result = associateSupervisionRecords(data, new Map(), decisions);
	expect(result[0]).toMatchObject({ status: "AUTO_CONFIRMED", selectedRecordId: "R", evidenceIds: ["E", "RE"] });
	expect(result[1].status).toBe("UNMATCHED");
	expect(data.rectifications[0].status).toBe("IN_PROGRESS");
});

it("does not auto assign one record to two plausible issues or a generic uncertain record", () => {
	for (const verdict of ["MATCH", "UNCERTAIN"] as const) {
		const decisions = new Map([decision("I1", verdict), decision("I2", verdict)].map((d) => [d.pairId, d]));
		expect(
			associateSupervisionRecords(input(), new Map(), decisions).every(
				(r) => r.status === "PENDING_REVIEW" && !r.selectedRecordId,
			),
		).toBe(true);
	}
});

it("preserves conflict handling for two model-confirmed records with different states", () => {
	const data = input();
	data.issues = data.issues.slice(0, 1);
	data.rectifications = [...data.rectifications, { ...data.rectifications[0], recordId: "R2", status: "IN_PROGRESS" }];
	const second = { ...decision("I1", "MATCH"), pairId: pairKey("I1", "R2") };
	const decisions = new Map([decision("I1", "MATCH"), second].map((d) => [d.pairId, d]));
	expect(associateSupervisionRecords(data, new Map(), decisions)[0].status).toBe("STATUS_CONFLICT");
});

it("does not assign a record while another candidate issue remains uncertain", () => {
	const decisions = new Map([decision("I1", "MATCH"), decision("I2", "UNCERTAIN")].map((d) => [d.pairId, d]));
	expect(associateSupervisionRecords(input(), new Map(), decisions).every((r) => !r.selectedRecordId)).toBe(true);
});

it("validates adjudication quotes and complete coverage", async () => {
	vi.stubEnv("AUDIT_AI_BASE_URL", "http://audit.test");
	vi.stubEnv("AUDIT_AI_INTERNAL_TOKEN", "test");
	const candidates = new Set([pairKey("I1", "R")]);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ decisions: [decision("I1", "MATCH")] })),
	);
	expect((await judgeAssociationCandidates(input(), candidates)).size).toBe(1);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ decisions: [{ ...decision("I1", "MATCH"), recordQuote: "伪造原文" }] })),
	);
	await expect(judgeAssociationCandidates(input(), candidates)).rejects.toThrow("Invalid association evidence");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ decisions: [] })),
	);
	await expect(judgeAssociationCandidates(input(), candidates)).rejects.toThrow("Incomplete association");
});

it("never confirms two issues just because they share a document number", () => {
	const relations = associateSupervisionRecords(input());
	expect(relations.every((r) => r.status === "PENDING_REVIEW" && !r.selectedRecordId)).toBe(true);
});

it("ignores caller supplied record-wide semantic score", () => {
	const data = input();
	const records = data.rectifications.map((r) => ({ ...r, referencedDocumentNumbers: [] }));
	expect(
		associateSupervisionRecords({ ...data, rectifications: records }).every((r) => r.status === "UNMATCHED"),
	).toBe(true);
});

it("computes and validates separate scores for each issue-record pair", async () => {
	vi.stubEnv("AUDIT_AI_BASE_URL", "http://audit.test");
	vi.stubEnv("AUDIT_AI_INTERNAL_TOKEN", "test");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, options: RequestInit) => {
			const body = JSON.parse(String(options.body));
			expect(body.pairs.map((p: { issueText: string }) => p.issueText)).toEqual(["设备未登记", "合同未审批"]);
			return Response.json({
				scores: [
					{ pairId: pairKey("I1", "R"), score: 0.95 },
					{ pairId: pairKey("I2", "R"), score: 0.2 },
				],
			});
		}),
	);
	const scores = await computeAssociationScores(input());
	expect(scores.get(pairKey("I1", "R"))).toBe(0.95);
	expect(scores.get(pairKey("I2", "R"))).toBe(0.2);
});

it("fails closed on missing backend scores", async () => {
	vi.stubEnv("AUDIT_AI_BASE_URL", "http://audit.test");
	vi.stubEnv("AUDIT_AI_INTERNAL_TOKEN", "test");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ scores: [] })),
	);
	await expect(computeAssociationScores(input())).rejects.toThrow("Incomplete similarity response");
});
