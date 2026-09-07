import { describe, expect, it } from "vitest";
import {
	createVersionDiffRuntime,
	parseVersionDiffPayload,
} from "../src/runtime/policy-compare/version-diff-runtime.ts";

const spec = {
	id: "policy-compare-version-diff",
	model: { role: "main" },
	toolset: "policy-compare",
	tools: ["list_internal_obligations"],
	limits: { runTimeoutMs: 60_000 },
	workflow: "policy-version-diff" as const,
};

describe("VersionDiffRuntime", () => {
	it("直接对 Java 下传的新旧版本条款做确定性差异比对", async () => {
		const runtime = createVersionDiffRuntime({
			spec,
			payload: {
				corpusType: "internal",
				newDocument: {
					documentId: "NEW",
					logicalId: "L1",
					title: "测试内规",
					issueDate: "2026-08-01",
					clauses: [{ seq: 1, clausePath: "第二条", text: "第二条 新正文" }],
				},
				oldDocument: {
					documentId: "OLD",
					logicalId: "L1",
					title: "测试内规",
					clauses: [{ seq: 1, clausePath: "第二条", text: "第二条 旧正文" }],
				},
			},
		});

		const result = await runtime.run("版本差异比对", { runId: "RUN-1" });

		expect(result.status).toBe("completed");
		expect(result.answer).toMatchObject({
			compareType: "version_diff",
			corpusType: "internal",
			metrics: { changed: 1 },
			newVersion: { issueDate: "2026-08-01", versionLabel: "发布日期：2026-08-01" },
			oldVersion: { issueDate: null, versionLabel: "发布日期未维护" },
		});
		expect(result.turns).toBe(0);
	});

	it("拒绝把不同版本链伪装成同一制度的新旧版本", () => {
		expect(() =>
			parseVersionDiffPayload({
				corpusType: "internal",
				newDocument: {
					documentId: "NEW",
					logicalId: "L1",
					title: "新",
					clauses: [{ seq: 1, clausePath: "第一条", text: "新" }],
				},
				oldDocument: {
					documentId: "OLD",
					logicalId: "L2",
					title: "旧",
					clauses: [{ seq: 1, clausePath: "第一条", text: "旧" }],
				},
			}),
		).toThrow(/同一制度版本链/);
	});
});
