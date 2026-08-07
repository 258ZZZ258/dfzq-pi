import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateCoverageResult } from "../src/runtime/policy-compare/validate-result.ts";
import { buildRuntime, cleanupPolicyCompareHarnesses, verdictReply } from "./helpers/policy-compare.ts";

/**
 * 制度比对 · 规格 §8.1 A1–A9 验收台账(**档 1,无语料**)。
 *
 * 这份文件不是「重新测一遍功能」——A2/A6/A8/A9 已经在下面几个文件里被逐条覆盖过,这里只是
 * 给出可以直接跳转核实的落点。真正补的是 A1(此前只有 schema 单测,没有端到端产出过一份
 * 真结果去过 schema)与 A7(五个 fail-closed 场景此前散落或缺失)。
 *
 * ┌────┬──────────────────────────────────┬──────────────────────────────────────────────┐
 * │ 判据 │ 规格 §8.1 定义                      │ 落点(档 1)                                      │
 * ├────┼──────────────────────────────────┼──────────────────────────────────────────────┤
 * │ A1 │ 输出契约:通过 §6.1 schema           │ 本文件「A1 输出契约」                              │
 * │ A2 │ 正文非模型产出                       │ policy-compare-runtime.test.ts ›「模型不产正文」    │
 * │    │                                    │ policy-compare-validate.test.ts › 反幻觉 2 两条     │
 * │ A3 │ 引用可回查                          │ **档 2**(本档 it.todo,不声称)                     │
 * │ A4 │ 权限不越界                          │ **档 2**(本档 it.todo,不声称)                     │
 * │ A5 │ 计数自洽(§6.3 第 3、4 条)            │ 本文件「A5 计数自洽」+                             │
 * │    │                                    │ policy-compare-validate.test.ts › 反幻觉 3/4        │
 * │ A6 │ 不静默丢(unmatched/rejected/       │ policy-compare-align.test.ts(各 unmatched reason)   │
 * │    │ unresolved/truncated)              │ policy-compare-assemble.test.ts(gaps+metrics)       │
 * │    │                                    │ policy-compare-runtime.test.ts ›「A6」「A6b」「守恒」 │
 * │ A7 │ fail-closed 五场景各返回预期错误      │ 本文件「A7-1」..「A7-5」                            │
 * │    │ 且不返回结果                         │                                                │
 * │ A8 │ 模型调用次数可算                     │ policy-compare-runtime.test.ts ›「A8」「A8b」        │
 * │ A9 │ 进度单调                            │ policy-compare-runtime.test.ts ›「A9」+「阶段顺序合法」│
 * └────┴──────────────────────────────────┴──────────────────────────────────────────────┘
 *
 * ⚠ 规格 §8.1 A7 那一行原文写的是「无 filters · 空 corpusTypes · corpusTypes 不含 internal ·
 * M2 全 unresolved · 达梦不可达」—— 那是「制度查询」管线的五个场景,不是本管线的。本管线
 * (PolicyCompareRuntime)实际存在、且有代码路径可测的 fail-closed 闸门是下面 A7-1..5 这五个;
 * 与本任务 brief(task-13-brief.md Step 1)、及 §8.2 分档表下方「A7 五个 fail-closed 用例必须写」
 * 那行的操作化定义一致。规格原文这行本身没有随实现更新,是任务链路里遗留的不一致,记在这里
 * 供后续勘误,本文件按 brief 的操作化定义走。
 *
 * ⚠ §8.2 分档表把验收明确分成两档,不得合并:
 * - 档 1 · 无语料:今天可跑,A1/A2/A5/A6/A7/A8/A9,用 fixture 与 fake MCP 构造(本文件属于这档)。
 * - 档 2 · 有语料:内规入库 + 跑过 enrich E1 + 达梦映射字段到位,追加 A3/A4,端到端真跑。
 *   三个前提今天都不成立 —— A3/A4 用 `it.todo` 显式挂起,不用 `expect(true).toBe(true)` 那种
 *   会在测试报告里显示成「通过」的假断言(那正好会制造「本文件全绿 ⇒ A1-A9 全过」的误读)。
 */

const schema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-compare/coverage.schema.json", import.meta.url)), "utf8"),
);
const parse = (output: string) => JSON.parse(output.replace(/```json\n|\n```/g, ""));

afterEach(async () => {
	await cleanupPolicyCompareHarnesses();
});

describe("制度比对 · 档 1 验收(无语料,fixture + fake MCP)", () => {
	it("A1 输出契约:产物过 §6.1 schema", async () => {
		const { runtime } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		const body = parse(result.output!);
		expect(
			validateCoverageResult(
				body,
				{
					internalChunkIds: new Set(["C-0", "C-1"]),
					externalTexts: new Set(["外规第五条正文", "外规第十条正文"]),
					internalTexts: new Set(["内规第0条正文", "内规第1条正文"]),
					checkedCount: 2,
				},
				schema,
			),
		).toEqual({ ok: true });
	});

	it("A7-1 fail-closed:documents:process 报错 ⇒ run 落 error,不产结果", async () => {
		const { runtime } = await buildRuntime({
			modelReplies: [verdictReply([])],
			documentsThrows: "415 unsupported type",
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		// 不只查 status —— 要核实落地的确实是 documents:process 这道闸,不是别的路径也
		// 正好把 run 判成 error(比如阶段 6 的 schema 校验)。
		expect(result.errorMessage).toContain("415");
	});

	it("A7-2 fail-closed:M1 返回形状不对 ⇒ error,不当成零义务", async () => {
		const { runtime } = await buildRuntime({ modelReplies: [verdictReply([])], obligationsMalformed: true });
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		// "items" 是 toObligations() 里那句报错消息的关键字 —— 定位到具体是 M1 的形状校验拦下的,
		// 不是巧合落在别的 error 分支(比如 M2 或阶段 6)。
		expect(result.errorMessage).toContain("items");
		expect(result.errorMessage).toContain("list_internal_obligations");
	});

	it("A7-3 fail-closed:M2 抛 JSON-RPC error ⇒ error,不产半张表", async () => {
		const { runtime } = await buildRuntime({
			modelReplies: [verdictReply([])],
			resolveThrows: "source_law mapping unavailable",
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("source_law mapping unavailable");
	});

	it("A7-4 fail-closed:上传件零条款块 ⇒ error,不当成「完全覆盖」", async () => {
		const { runtime } = await buildRuntime({ modelReplies: [verdictReply([])], artifactNoClauses: true });
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		// "条款块" 定位到 parseArtifact 里那句「artifact 里没有任何条款块」—— 不是随便一个
		// error,是这道特定的闸。
		expect(result.errorMessage).toContain("条款块");
	});

	it("A7-5 fail-closed:payload.scope.organizations 非空 ⇒ 构造期拒绝", async () => {
		await expect(
			buildRuntime({ modelReplies: [], payloadOverride: { scope: { organizations: ["东方证券"] } } }),
		).rejects.toThrow(/组织/);
	});

	it("A5 计数自洽:metrics 四项之和 == checked", async () => {
		const { runtime } = await buildRuntime({
			obligationCount: 3,
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "missing", gap: "a", suggestion: "b" },
					{ pairIndex: 2, state: "conflict", conflictType: "口径冲突", gap: "c", suggestion: "d" },
				]),
			],
		});
		const m = parse((await runtime.run("比对")).output!).metrics;
		expect(m.missing + m.conflict + m.covered + m.unmatched).toBe(m.checked);
	});

	// 规格 §8.2:A3(引用可回查)与 A4(权限不越界)需要内规入库 + 跑过 E1 义务标 +
	// 达梦映射字段到位,三者都不成立,本档**不验也不声称**。用 it.todo 而不是一条
	// `expect(true).toBe(true)`:后者会在测试输出里显示成「通过」,正好制造它想防止的
	// 那个误读;it.todo 在输出里是待办,断言不了任何东西,也不假装通过。
	it.todo("A3 引用可回查 —— 需真语料(规格 §8.2 档 2)");
	it.todo("A4 权限不越界 —— 需真语料(规格 §8.2 档 2)");
});
