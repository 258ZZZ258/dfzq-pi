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
 * 真结果去过 schema)与 A7(此前没有一处把 `PolicyCompareRuntime` 自己管线上的五个
 * fail-closed 闸门集中列在同一份"档 1 全部判据都能逐条指认"的文件里)。A7-1/A7-3 此前确实
 * 没有任何测试;A7-2/A7-5 与 `policy-compare-runtime.test.ts` 已有的单测覆盖同一道闸,这里
 * 是经完整 runtime 装配的集成级复查;A7-4 也有一条同名结论的既存测试,但那条是手写一个
 * `artifacts.fetch` 直接 `throw` 固定文案(伪造的错),这里的 `artifactNoClauses` 走真实
 * `parseArtifact` 去解析一份 `chunks: []` 的产物——两者不是一回事:后者才真的验证了
 * `parseArtifact` 自己那道零条款块校验存在且接到了这条装配路径上(下面「两次变异测试」的
 * 第一条就是删掉 `parseArtifact` 里那道真校验,确认 A7-4 会红——如果 A7-4 也是伪造的
 * throw,这个变异测试根本测不出任何东西)。
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
 * │ A7 │ fail-closed 五场景各返回预期错误      │ 本文件「A7-1」..「A7-5」(见下方说明)                 │
 * │    │ 且不返回结果                         │                                                │
 * │ A8 │ 模型调用次数可算                     │ policy-compare-runtime.test.ts ›「A8」「A8b」        │
 * │ A9 │ 进度单调                            │ policy-compare-runtime.test.ts ›「A9」+「阶段顺序合法」│
 * └────┴──────────────────────────────────┴──────────────────────────────────────────────┘
 *
 * ⚠ 规格 §8.1 A7 那一行原文写的是「无 filters · 空 corpusTypes · corpusTypes 不含 internal ·
 * M2 全 unresolved · 达梦不可达」。这五个场景**都是本管线自己的**,不是从「制度查询」借来
 * 的——但档 1(无语料)只能验其中三个,另外两个不在这份文件是有具体原因的,分四点说清楚:
 *
 * 1. `filters`/`corpusTypes` 与 M1/M2 都是本 runtime(制度比对)自己的契约:`filters` 是
 *    `POST /runs` 请求体里与 `payload` 同级的字段(规格 §3.1);M1 `list_internal_obligations`、
 *    M2 `resolve_source_law` 是规格 §1 组件清单、§5.1/§5.2 定义的、本工作流专属的新建工具。
 *    授权位(`perm_tags`/`corpus_types`)按 §5.1/§5.2 的「注入(不可见)」原样在 **MCP toolset
 *    层**注入给 M1/M2——具体是 `src/server/main.ts` 里 `createMcpToolset(...)` 那一段,建在
 *    `if (spec.workflow === "policy-compare")` 分支**之前**,`runtime.ts` 本身看不到、也不
 *    需要看到 `filters`。这是规格 §7.1 明确写了的形态(「不把结构化输入塞进 input 的 JSON
 *    字符串——那会绕过 HTTP 层的四档 fail-closed 校验」),不是本轮的缺口,`runtime.ts` 里
 *    不该再加一份 filters 处理。
 *
 * 2. 「无 filters」「空 corpusTypes」两条**已经实现并测过**,只是不在这份档 1 文件里:
 *    `src/server/middleware/validate.ts` 的 `validateSubmitBody()` 对缺失/空的
 *    `filters.corpusTypes` 返回 `missing_authorization_scope`,在 `src/server/app.ts` 里
 *    `validateSubmitBody(raw)` 排在 `router.resolve(taskKind)` **之前**,对每一次
 *    `POST /runs` 生效、不分 taskKind;`test/router.test.ts` 的
 *    "rejects a missing filters block with missing_authorization_scope" 与
 *    "rejects an empty corpusTypes with missing_authorization_scope" 两条用例覆盖。
 *
 * 3. 「A7 五个 fail-closed 用例必须写」这句话实际出自规格 **§10 工作量**表(「档 1 验收」
 *    那一行的备注),不是 §8.2——它只是重申 §8.1 的同一条要求,不构成另一套操作定义。
 *
 * 4. 剩下两条——「corpusTypes 不含 internal」与「达梦不可达」——档 1 确实验不了,但原因是
 *    它们是 **M1/M2(dfzq-audit-ai,Python 侧)自己的 fail-closed 行为**(规格 §5.1
 *    「corpus_types 不含 internal → error -32602」、§5.2「达梦不可达 → error -32000」),
 *    本计划只覆盖 dfzq-pi TS 侧,M1/M2 的实现与验收属于 audit-ai 那份计划的范围。本 runtime
 *    (TS 侧)能验、也必须验的是收到这类错误之后的反应——「工具报错时 run 落 error、不返回
 *    结果」,这条不区分错误的具体原因:`assembled.callTool` 对任何工具名的 `execute()`
 *    抛错都走同一条 rethrow 路径(见 `assembler.ts`),不必为「达梦不可达」这个具体消息
 *    另起一条测试;由下面 A7-3(M2 抛错)覆盖。
 *
 * 综上,下面 A7-1..5 与规格 §8.1 原文那五个例子不是逐字对应关系:A7-3 直接对应「M2 全
 * unresolved」(错误消息 `source_law mapping unavailable` 与规格 §5.2 fail-closed 表原文
 * 一致),其余四条(documents:process 报错、M1 形状不对、上传件零条款块、payload 组织维度
 * 非空)是 `PolicyCompareRuntime` 自己管线上另外四个有代码路径可测的 fail-closed 闸门 ——
 * 覆盖的是 A7「fail-closed 生效」这条判据的精神(管线任一环节失败都不静默产出),不是重复
 * 造一遍已经在 `validate.ts`/`test/router.test.ts` 测过的 HTTP 边界校验,也不是去猜 M1/M2
 * Python 侧的具体故障消息。
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

	// ⚠ 与 policy-compare-runtime.test.ts 的"list_internal_obligations 返回形状不对(缺 items
	// 数组)→ 不产出结果"几乎是同一件事,那条测的是 toObligations() 这个纯函数级别的分支;这里
	// 用 buildRuntime 走完整 createPolicyCompareRuntime 装配再验一遍,是**合法的集成级复查**
	// (确认 fail-closed 不会在装配/接线的某处被悄悄吞掉),不是重复造轮子,但也不是"此前缺失"
	// ——只是在这份验收文件里再确认一次「档 1 逐条可指认」这条要求。
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

	// ⚠ policy-compare-runtime.test.ts 有一条"外规解析失败(artifacts.fetch 抛错)"用例断言
	// 同样的错误消息,但那条是手写一个 `artifacts.fetch` 直接 throw 固定文案——测的是 runtime.ts
	// 正确传播 artifacts.fetch() 的错误,不是 parseArtifact 自己那道零条款块校验真的存在。这条
	// 用 `artifactNoClauses` 走真实 parseArtifact,是本文件"两次变异测试"里被验证过真的会红的
	// 那一条(见文件顶部说明)。
	it("A7-4 fail-closed:上传件零条款块 ⇒ error,不当成「完全覆盖」", async () => {
		const { runtime } = await buildRuntime({ modelReplies: [verdictReply([])], artifactNoClauses: true });
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		// "条款块" 定位到 parseArtifact 里那句「artifact 里没有任何条款块」—— 不是随便一个
		// error,是这道特定的闸。
		expect(result.errorMessage).toContain("条款块");
	});

	// ⚠ 与 policy-compare-runtime.test.ts 的"scope.organizations 非空 → 抛错"是同一条
	// parseCoveragePayload 单测的集成级复查(那条直接调 parseCoveragePayload();这条经完整
	// buildRuntime()/createPolicyCompareRuntime() 走一遍,确认这道闸真的接在装配路径上、不是
	// 只在单元测试里成立)。
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
