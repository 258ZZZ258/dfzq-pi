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
	it("只向审计知识库请求指定的新旧版本，并直接把确定性结果作为 answer", async () => {
		const calls: unknown[] = [];
		const runtime = createVersionDiffRuntime({
			spec,
			payload: { newDocVersionId: "NEW", oldDocVersionId: "OLD" },
			permissionTags: ["内部"],
			documents: {
				process: async () => {
					throw new Error("not used");
				},
				compareVersions: async (request) => {
					calls.push(request);
					return {
						compareType: "version_diff",
						corpusType: "internal",
						logicalId: "L1",
						newVersion: {
							docVersionId: "NEW",
							title: "测试内规",
							versionLabel: "2026版",
							versionStatus: "effective",
						},
						oldVersion: {
							docVersionId: "OLD",
							title: "测试内规",
							versionLabel: "2025版",
							versionStatus: "superseded",
						},
						metrics: { added: 0, removed: 0, changed: 1, moved: 0, total: 1 },
						rows: [
							{
								index: 1,
								tabKey: "changed",
								place: "第二条",
								policyA: "新",
								policyB: "旧",
								level: "修改",
								description: "新旧版本条款内容变更",
							},
						],
						finish_reason: "stop",
					};
				},
			},
		});

		const result = await runtime.run("版本差异比对", { runId: "RUN-1" });

		expect(calls).toEqual([{ newDocVersionId: "NEW", oldDocVersionId: "OLD", permTags: ["内部"] }]);
		expect(result.status).toBe("completed");
		expect(result.answer).toMatchObject({ compareType: "version_diff", metrics: { changed: 1 } });
		expect(result.turns).toBe(0);
	});

	it("拒绝把同一 doc_version_id 伪装成新旧两版", () => {
		expect(() => parseVersionDiffPayload({ newDocVersionId: "SAME", oldDocVersionId: "SAME" })).toThrow(/必须不同/);
	});
});
