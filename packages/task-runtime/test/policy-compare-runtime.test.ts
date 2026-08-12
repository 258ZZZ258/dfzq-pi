import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import {
	createPolicyCompareRuntime,
	DEFAULT_BATCH_SIZE,
	MAX_OBLIGATIONS,
	MAX_PAIRS,
	type PolicyCompareRuntimeOptions,
	parseCoveragePayload,
} from "../src/runtime/policy-compare/runtime.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { fauxAssistantMessage } from "./helpers/faux.ts";
import { buildRuntime, cleanupPolicyCompareHarnesses, profile, verdictReply } from "./helpers/policy-compare.ts";

const ok = {
	external: { objectKey: "upload/U1/a.pdf", uploadId: "U1", filename: "a.pdf" },
	scope: { organizations: [], bizDomains: ["费用报销"], chapters: ["第二章"] },
	outputTypes: ["summary_diff", "missing_items", "partial_items", "conflict_items"],
};

describe("parseCoveragePayload", () => {
	it("合法 payload 通过", () => {
		const external = parseCoveragePayload(ok).external!;
		expect(external.source === "upload" ? external.uploadId : "").toBe("U1");
	});

	it("知识库外规版本 payload 通过", () => {
		const got = parseCoveragePayload({ ...ok, external: { source: "library", docVersionId: "DV-1" } });
		expect(got.external).toEqual({ source: "library", docVersionId: "DV-1" });
	});

	it("知识库内规 payload 自动切换为内规追踪外规版本", () => {
		const got = parseCoveragePayload({
			direction: "internal_to_external",
			internal: { source: "library", docVersionId: "INT-DV-1" },
			scope: { effectiveDateRange: ["2024-01-01", "2026-12-31"] },
		});
		expect(got.direction).toBe("internal_to_external");
		expect(got.internal).toEqual({ source: "library", docVersionId: "INT-DV-1" });
		expect(got.external).toBeUndefined();
	});

	it("上传内规 payload 通过", () => {
		const got = parseCoveragePayload({
			direction: "internal_to_external",
			internal: { objectKey: "upload/I1/a.docx", uploadId: "I1", filename: "a.docx" },
			scope: {},
		});
		expect(got.internal).toEqual({
			source: "upload",
			objectKey: "upload/I1/a.docx",
			uploadId: "I1",
			filename: "a.docx",
		});
	});

	it("缺 external.objectKey → 抛错", () => {
		expect(() => parseCoveragePayload({ ...ok, external: { uploadId: "U1", filename: "a.pdf" } })).toThrow(
			/objectKey/,
		);
	});

	it("scope.organizations 非空 → 抛错(维度未实现,不静默忽略)", () => {
		expect(() => parseCoveragePayload({ ...ok, scope: { ...ok.scope, organizations: ["东方证券"] } })).toThrow(
			/组织/,
		);
	});

	it("outputTypes 非全选 → 抛错", () => {
		expect(() => parseCoveragePayload({ ...ok, outputTypes: ["missing_items"] })).toThrow(/outputTypes/);
	});

	it("outputTypes 缺省 → 按全选通过", () => {
		const { outputTypes: _drop, ...rest } = ok;
		expect(() => parseCoveragePayload(rest)).not.toThrow();
	});

	it("payload 不是对象 → 抛错", () => {
		expect(() => parseCoveragePayload("x")).toThrow(/payload/);
	});

	/**
	 * 终审 I4:三个收窄参数此前用 `Array.isArray(x) ? x : undefined` —— 形状不对就**静默降级**
	 * 成「不限」。Java 传 `bizDomains: "费用报销"`(单值忘了包数组,常见的上游 bug)会被整个
	 * 丢掉,M1 收到空数组 = 不限,比对范围悄悄放大到全部内规。与紧邻的 `organizations` 那句
	 * 「静默忽略一个范围收窄参数等于越权返回」自相矛盾,现统一成形状不对即抛。
	 */
	describe("scope 收窄参数 fail-closed(终审 I4)", () => {
		const withScope = (scope: Record<string, unknown>) => () => parseCoveragePayload({ ...ok, scope });

		it("bizDomains 是单个字符串(没包数组)→ 抛错,不静默降级成「不限」", () => {
			expect(withScope({ organizations: [], bizDomains: "费用报销" })).toThrow(/bizDomains/);
		});

		it("chapters 是单个字符串 → 抛错", () => {
			expect(withScope({ organizations: [], chapters: "第二章" })).toThrow(/chapters/);
		});

		it("数组元素不是字符串(如 [123])→ 抛错,不原样下传给 M1", () => {
			expect(withScope({ organizations: [], bizDomains: [123] })).toThrow(/bizDomains/);
		});

		it("数组元素是空串 → 抛错(空串收窄不了任何东西,是上游拼串出了问题)", () => {
			expect(withScope({ organizations: [], chapters: [""] })).toThrow(/chapters/);
		});

		it("effectiveDateRange 不是两元组 → 抛错", () => {
			expect(withScope({ organizations: [], effectiveDateRange: ["2024-01-01"] })).toThrow(/effectiveDateRange/);
			expect(withScope({ organizations: [], effectiveDateRange: "2024-01-01" })).toThrow(/effectiveDateRange/);
			expect(withScope({ organizations: [], effectiveDateRange: [2024, 2026] })).toThrow(/effectiveDateRange/);
		});

		it("organizations 是非数组 → 也抛错(此前 Array.isArray 判假就放行,同一条原则漏了自己)", () => {
			expect(withScope({ organizations: "东方证券" })).toThrow(/organizations/);
		});

		// 复审 Minor 3:非数组的 organizations 此前先撞「必须是非空字符串数组」的形状错误,暗示
		// 改成数组就能过;改成 `["东方证券"]` 重试后才真正撞见「未实现」——两轮才诊断得清。现在
		// 不管形状对不对,一次性说清「未实现」,不再先诱导去修形状。
		it("organizations 非数组时,错误信息一次说清「未实现」,不先诱导按数组格式重传(Minor 3)", () => {
			expect(withScope({ organizations: "东方证券" })).toThrow(/未实现/);
			expect(withScope({ organizations: "东方证券" })).not.toThrow(/必须是非空字符串数组/);
		});

		it("null 与缺席同义:按「不限」处理,不抛", () => {
			const got = parseCoveragePayload({
				...ok,
				scope: { organizations: [], bizDomains: null, chapters: null, effectiveDateRange: null },
			});
			expect(got.scope.bizDomains).toBeUndefined();
			expect(got.scope.chapters).toBeUndefined();
			expect(got.scope.effectiveDateRange).toBeUndefined();
		});

		it("合法值原样带出(不是被上面几条顺带满足的恒真断言)", () => {
			const got = parseCoveragePayload({
				...ok,
				scope: {
					organizations: [],
					bizDomains: ["费用报销"],
					chapters: ["第二章"],
					effectiveDateRange: ["2024-01-01", "2026-12-31"],
				},
			});
			expect(got.scope.bizDomains).toEqual(["费用报销"]);
			expect(got.scope.chapters).toEqual(["第二章"]);
			expect(got.scope.effectiveDateRange).toEqual(["2024-01-01", "2026-12-31"]);
		});
	});
});

const schema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-compare/coverage.schema.json", import.meta.url)), "utf8"),
);

afterEach(async () => {
	await cleanupPolicyCompareHarnesses();
});

/** Polls `predicate` until it's true. 与 fast-path-runtime.test.ts 的同名 helper 同一手法
 *  (照抄,未合并进共享 helpers/):等一个异步中间态出现,再继续断言。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000, stepMs = 1): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

describe("PolicyCompareRuntime 端到端(fake 工具 + faux 模型)", () => {
	it("知识库内规只做显式引用外规版本核查,不调用 MCP 工具或模型", async () => {
		const requests: unknown[] = [];
		const { runtime, toolCalls, faux } = await buildRuntime({
			modelReplies: [],
			payloadOverride: {
				direction: "internal_to_external",
				internal: { source: "library", docVersionId: "INT-DV-1" },
				scope: { effectiveDateRange: ["2024-01-01", "2026-12-31"] },
			},
			documents: {
				process: async () => {
					throw new Error("知识库内规不应重新解析");
				},
				checkInternalReferenceVersions: async (req) => {
					requests.push(req);
					return {
						compareType: "internal_to_external",
						metrics: { checked: 0, missing: 0, conflict: 0, covered: 0, unmatched: 0, linked: 0 },
						rows: [],
						gaps: ["当前内规没有可解析的显式外规引用"],
						finish_reason: "stop",
					};
				},
			},
		});
		const result = await runtime.run("核查引用外规版本");
		expect(result.status).toBe("completed");
		expect(result.turns).toBe(0);
		expect(toolCalls).toEqual([]);
		expect(faux.state.callCount).toBe(0);
		expect(requests).toEqual([
			{
				docVersionId: "INT-DV-1",
				clauses: undefined,
				effectiveDateRange: ["2024-01-01", "2026-12-31"],
				permTags: [],
			},
		]);
	});

	it("上传内规先按 internal 解析,再核查条款中的外规引用", async () => {
		const processRequests: unknown[] = [];
		const checkRequests: unknown[] = [];
		const { runtime } = await buildRuntime({
			modelReplies: [],
			payloadOverride: {
				direction: "internal_to_external",
				internal: {
					source: "upload",
					objectKey: "upload/I1/internal.pdf",
					uploadId: "I1",
					filename: "internal.pdf",
				},
			},
			documents: {
				process: async (req) => {
					processRequests.push(req);
					return {
						uploadId: "I1",
						artifactKey: "artifact/I1.json",
						title: "上传内规",
						pageCount: 1,
						chunkCount: 2,
						status: "ok",
					};
				},
				checkInternalReferenceVersions: async (req) => {
					checkRequests.push(req);
					return {
						compareType: "internal_to_external",
						metrics: { checked: 0, missing: 0, conflict: 0, covered: 0, unmatched: 0, linked: 0 },
						rows: [],
						finish_reason: "stop",
					};
				},
			},
		});
		const result = await runtime.run("核查上传内规");
		expect(result.status).toBe("completed");
		expect(processRequests).toEqual([
			{
				objectKey: "upload/I1/internal.pdf",
				uploadId: "I1",
				filename: "internal.pdf",
				corpusHint: "internal",
			},
		]);
		expect(checkRequests).toHaveLength(1);
		expect(checkRequests[0]).toMatchObject({ docVersionId: undefined });
		expect((checkRequests[0] as { clauses: unknown[] }).clauses).toHaveLength(2);
	});

	it("跑完六阶段并产出合规行表", async () => {
		const { runtime, toolCalls, resolutionsArgs } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "missing", gap: "缺期限", suggestion: "补期限" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("completed");
		expect(toolCalls).toEqual(["list_internal_obligations", "resolve_source_law"]);
		expect(resolutionsArgs).toEqual([
			{
				chunk_ids: ["C-0", "C-1"],
				target_document: { title: "基准外规", doc_no: null },
			},
		]);
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, ""));
		expect(body.compareType).toBe("external_to_internal");
		expect(body.rows).toHaveLength(1);
		expect(body.rows[0].externalClause).toBe("外规第五条正文");
		expect(body.metrics.checked).toBe(2);
		// 评审 Finding 4:completed 路径此前硬编码 usage 全 0 —— 一个真打了模型调用的 run 在
		// 账面上显示成免费。faux provider 的 withUsageEstimate 按字符数估算 token,只要真的发生
		// 过至少一次 session.prompt(),input/output/total 必然非零。不断言 cost —— faux 计费
		// 恒为 0(profile.roles.main.cost 全 0),断言它只是在验证一个必然成立的常量,没有判别力。
		expect(result.usage.input).toBeGreaterThan(0);
		expect(result.usage.output).toBeGreaterThan(0);
		expect(result.usage.total).toBeGreaterThan(0);
	});

	it("A8:模型调用次数 == ceil(pairs/batchSize),零额外调用", async () => {
		const { runtime, faux } = await buildRuntime({
			obligationCount: 5,
			batchSize: 2,
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
				verdictReply([
					{ pairIndex: 2, state: "covered" },
					{ pairIndex: 3, state: "covered" },
				]),
				verdictReply([{ pairIndex: 4, state: "covered" }]),
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("completed");
		expect(result.turns).toBe(3); // ceil(5/2)
		// 独立佐证:不只信任 runtime 自报的 turns(即实现内部的 modelCalls 计数器),也核对
		// faux 模型自己记的真实调用次数(harness.faux.state.callCount,与 runtime.ts 里的
		// modelCalls 完全独立、由 pi-ai 的 faux provider 在每次真实 stream 调用时自增)——
		// 若某处多调了一次 session.prompt() 但忘了同步给 modelCalls 计数,只看 turns 会被
		// 蒙混过关,这条不会。
		expect(faux.state.callCount).toBe(3);
	});

	it("A8b:batchSize 缺省时按 DEFAULT_BATCH_SIZE(8)分批,不是别的默认值", async () => {
		// 9 条义务、默认批大小 8 ⇒ ceil(9/8)=2 次模型调用。若默认值被改成别的数字
		// (比如 10),这里会变成 1,测试翻红。
		const replies = Array.from({ length: Math.ceil(9 / DEFAULT_BATCH_SIZE) }, (_, batchIdx) => {
			const start = batchIdx * DEFAULT_BATCH_SIZE;
			const end = Math.min(start + DEFAULT_BATCH_SIZE, 9);
			return verdictReply(
				Array.from({ length: end - start }, (_, j) => ({ pairIndex: start + j, state: "covered" })),
			);
		});
		const { runtime } = await buildRuntime({ obligationCount: 9, modelReplies: replies });
		const result = await runtime.run("比对");
		expect(result.status).toBe("completed");
		expect(result.turns).toBe(Math.ceil(9 / DEFAULT_BATCH_SIZE));
	});

	it("A9:compare_stage 的 percent 单调不减,终态 current==total", async () => {
		const { runtime } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const events: RuntimeEvent[] = [];
		runtime.subscribe((e) => {
			if (e.type === "compare_stage") events.push(e);
		});
		await runtime.run("比对");
		const percents = events.map((e) => (e.payload as { percent: number }).percent);
		expect(percents).toEqual([...percents].sort((a, b) => a - b));
		const last = events.at(-1)!.payload as { current: number; total: number };
		expect(last.current).toBe(last.total);
	});

	it("阶段顺序合法:stage 字段只能按 extracting→matching→judging→assembling 前进,不倒退", async () => {
		const STAGE_ORDER = ["extracting", "matching", "judging", "assembling"];
		const { runtime } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const events: RuntimeEvent[] = [];
		runtime.subscribe((e) => {
			if (e.type === "compare_stage") events.push(e);
		});
		await runtime.run("比对");
		const stages = events.map((e) => (e.payload as { stage: string }).stage);
		const ranks = stages.map((s) => STAGE_ORDER.indexOf(s));
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(stages[0]).toBe("extracting");
		expect(stages.at(-1)).toBe("assembling");
	});

	it("A6:unresolved 同时进 metrics.unmatched 与 gaps", async () => {
		const { runtime } = await buildRuntime({
			obligationCount: 2,
			unresolvedIds: ["C-1"],
			modelReplies: [verdictReply([{ pairIndex: 0, state: "covered" }])],
		});
		const result = await runtime.run("比对");
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, ""));
		expect(body.metrics.unmatched).toBe(1);
		// ⚠ 评审 Finding 3:不能只断言 gaps 里含 "C-1" —— align.ts 会独立地把同一个 chunk id
		// 因为 source_law_unresolved 推进 alignment.unmatched,assemble.ts 再把它变成一条也含
		// "C-1" 的 gap("内规条款 C-1 未对齐到上传外规:...")。那条路径与 runtime.ts 这里
		// `resolutions.unresolved.map(...)` 写进 extraGaps 的那句是两回事,只查子串
		// "C-1"会被前者悄悄顶住,删掉 runtime.ts 里 unresolved 那一行也不会有任何测试翻红。
		// 断言 runtime.ts 自己那句消息的确切文案,才是真的在守这条线。
		expect(body.gaps.join("\n")).toContain("内规条款 C-1 在源库中没有外规映射");
	});

	it("A6b:rejected 也进 gaps(与 unresolved 是两个不同字段,都不静默丢)", async () => {
		const { runtime } = await buildRuntime({
			obligationCount: 2,
			rejectedIds: ["C-9"],
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, ""));
		expect(body.gaps.join("\n")).toContain("C-9");
	});

	it("守恒:checkedCount 用实际处理条数(items.length),不是库内 total(被截断时两者不同)", async () => {
		const { runtime } = await buildRuntime({
			obligationCount: 2,
			truncated: true,
			libraryTotal: 999,
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, ""));
		// items.length=2,不是 libraryTotal=999 —— 这是 2026-08-06 控制端裁定的那条口径。
		expect(body.metrics.checked).toBe(2);
		expect(body.gaps.some((g: string) => g.includes("999"))).toBe(true);
	});

	it("阶段 2 请求参数:limit 封顶在 MAX_OBLIGATIONS(500,规格 §3.5 护栏定值)", async () => {
		const { runtime, obligationsArgs } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		await runtime.run("比对");
		expect(obligationsArgs[0]?.limit).toBe(MAX_OBLIGATIONS);
	});

	/**
	 * 终审 I4:`scope` 的三个收窄参数整条透传链此前**零测试** —— 把 runtime.ts 里下传它们的那
	 * 四行整个删掉,当时没有任何测试会红。收窄参数丢一个,M1 就按「不限」处理,比对范围会从
	 * 「费用报销这一个域」悄悄放大到全部内规,而调用方看到的是一次正常完成的 run。
	 */
	it("阶段 2 请求参数:scope 的三个收窄参数逐字下传给 M1(biz_domains/chapters/effective_from/effective_to)", async () => {
		const { runtime, obligationsArgs } = await buildRuntime({
			payloadOverride: {
				scope: {
					bizDomains: ["费用报销", "差旅费用报销"],
					chapters: ["第二章 报销原则", "第三章 审批规则"],
					effectiveDateRange: ["2024-01-01", "2026-12-31"],
				},
			},
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("completed");
		expect(obligationsArgs[0]?.biz_domains).toEqual(["费用报销", "差旅费用报销"]);
		expect(obligationsArgs[0]?.chapters).toEqual(["第二章 报销原则", "第三章 审批规则"]);
		expect(obligationsArgs[0]?.effective_from).toBe("2024-01-01");
		expect(obligationsArgs[0]?.effective_to).toBe("2026-12-31");
	});

	it("阶段 2 请求参数:scope 全缺省时下传空数组(= 不限),日期两端不传键", async () => {
		const { runtime, obligationsArgs } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		await runtime.run("比对");
		expect(obligationsArgs[0]?.biz_domains).toEqual([]);
		expect(obligationsArgs[0]?.chapters).toEqual([]);
		expect(obligationsArgs[0]?.effective_from).toBeUndefined();
		expect(obligationsArgs[0]?.effective_to).toBeUndefined();
	});

	it("模型不产正文:即使模型回了 externalClause,行表里也是原文", async () => {
		const { runtime } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "missing", gap: "g", suggestion: "s", externalClause: "模型编的正文" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, ""));
		expect(body.rows[0].externalClause).toBe("外规第五条正文");
	});

	it("steer / followUp 抛错", async () => {
		const { runtime } = await buildRuntime({ modelReplies: [verdictReply([])] });
		await expect(runtime.steer("x")).rejects.toThrow(/steer/);
		await expect(runtime.followUp("x")).rejects.toThrow(/followUp/);
	});

	it("模型看不见任何工具", async () => {
		const { runtime } = await buildRuntime({ modelReplies: [verdictReply([])] });
		// 直接读装配后模型可见的工具名 —— 这条不变量必须能被断言,不能靠「别的用例
		// 里模型没调工具」这种旁证(faux 模型本来就不调工具,删掉 setActiveToolsByName([])
		// 那一行不会有任何测试翻红)。探针的做法照 fast-path-runtime.ts 的
		// activeToolNamesForTest()。
		expect(runtime.activeToolNamesForTest()).toEqual([]);
	});

	it("Runtime.sessionId 来自 session.sessionId(不是 session.id)", async () => {
		const { runtime } = await buildRuntime({ modelReplies: [verdictReply([])] });
		// pi 的 AgentSession 没有 `.id`;若实现误读那个不存在的属性,这里会拿到
		// undefined,typeof 断言先炸。
		expect(typeof runtime.sessionId).toBe("string");
		expect(runtime.sessionId.length).toBeGreaterThan(0);
		expect(runtime.snapshot().sessionId).toBe(runtime.sessionId);
	});

	it("abort:中断标志在阶段间生效,后续阶段不再执行", async () => {
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const { runtime, toolCalls } = await buildRuntime({
			modelReplies: [verdictReply([])],
			documents: {
				process: async () => {
					// 卡住阶段 1,给测试机会在阶段 1 完成、阶段 2 开始之前调用 abort()。
					await gate;
					return {
						uploadId: "U1",
						artifactKey: "artifact/U1.json",
						title: "基准外规",
						pageCount: 1,
						chunkCount: 2,
						status: "ok",
					};
				},
			},
		});
		const runPromise = runtime.run("比对");
		await waitUntil(() => !runtime.isIdle);
		await runtime.abort();
		releaseGate();
		const result = await runPromise;
		expect(result.status).toBe("aborted");
		expect(result.output).toBeUndefined();
		// 阶段 2 的 checkPreempted() 在 list_internal_obligations 之前拦下 —— 工具从未被调用。
		expect(toolCalls).toEqual([]);
		// 评审 Finding 4 的 usage 非零断言放在下面「阶段 5 循环内」那条 —— 这条 abort 发生在
		// 阶段 1,从未真正调过模型,usage 本来就该是 0,在这里断言非零反而会是假判据。
	});

	it("catch 分支的 turns 如实带出已经真正发生过的模型调用次数,不是硬编码 0", async () => {
		// 逼阶段 6 的 Value.Check 直接抛(不是走 `!checked.ok` 的显式 return 分支 ——
		// 那个分支本来就正确地写 turns: modelCalls,不是这里要守的坏路径):
		// `Value.Check(null, result)` 会抛 "Cannot use 'in' operator to search for 'type' in
		// null"(typebox 对 null schema 的真实行为,已用一段独立脚本核实过),命中的正是
		// runInner() 之外那个 try/catch。此时阶段 5 的两批模型调用都已经真实跑完 ——
		// 若 catch 分支把 turns 硬编码成 0(此前的实现就是这样),这条会先红。
		const { runtime } = await buildRuntime({
			obligationCount: 2,
			batchSize: 1, // 两条义务、批大小 1 ⇒ 两批,两次真实模型调用都会先跑完再抛
			outputContractSchemaOverride: null,
			modelReplies: [
				verdictReply([{ pairIndex: 0, state: "covered" }]),
				verdictReply([{ pairIndex: 1, state: "covered" }]),
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.turns).toBe(2);
	});
});

describe("createPolicyCompareRuntime 装配期护栏", () => {
	function minimalGuardOptions(overrides: Partial<PolicyCompareRuntimeOptions> = {}): PolicyCompareRuntimeOptions {
		return {
			spec: {
				id: "policy-compare-coverage",
				model: { role: "main" },
				toolset: "pc",
				tools: ["list_internal_obligations", "resolve_source_law"],
				limits: {},
			},
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: new ToolsetRegistry(),
			cwd: "/tmp/pc-guard-cwd",
			agentDir: "/tmp/pc-guard-agentdir",
			outputContractSchema: schema,
			payload: { external: { objectKey: "upload/U1/a.pdf", uploadId: "U1", filename: "a.pdf" }, scope: {} },
			documents: {
				process: async () => {
					throw new Error("不应被调用 —— 护栏校验应在装配期(assemble() 之前)就挡下");
				},
			},
			artifacts: {
				fetch: async () => {
					throw new Error("不应被调用");
				},
			},
			...overrides,
		};
	}

	it("outputContractSchema 缺失 → 拒绝构造(阶段 6 每次都用它判)", async () => {
		await expect(
			createPolicyCompareRuntime(minimalGuardOptions({ outputContractSchema: undefined })),
		).rejects.toThrow(/outputContractSchema/);
	});

	it("batchSize=0 → 拒绝构造,不死循环(Task 4 评审携带项:batchPairs 的 for(...;i+=batchSize) 在 0 时死循环)", async () => {
		await expect(createPolicyCompareRuntime(minimalGuardOptions({ batchSize: 0 }))).rejects.toThrow(/batchSize/);
	});

	it("batchSize=-1(负数)→ 拒绝构造", async () => {
		await expect(createPolicyCompareRuntime(minimalGuardOptions({ batchSize: -1 }))).rejects.toThrow(/batchSize/);
	});

	it("batchSize=21(超上限 20)→ 拒绝构造", async () => {
		await expect(createPolicyCompareRuntime(minimalGuardOptions({ batchSize: 21 }))).rejects.toThrow(/batchSize/);
	});

	it("batchSize=1.5(非整数)→ 拒绝构造", async () => {
		await expect(createPolicyCompareRuntime(minimalGuardOptions({ batchSize: 1.5 }))).rejects.toThrow(/batchSize/);
	});
});

describe("PolicyCompareRuntime fail-closed(各条路径都不产出结果,不只是 status=error)", () => {
	it("上传外规切块数超上限(MAX_EXTERNAL_CHUNKS=800)→ 不产出结果", async () => {
		const { runtime } = await buildRuntime({
			modelReplies: [verdictReply([])],
			documents: {
				process: async () => ({
					uploadId: "U1",
					artifactKey: "artifact/U1.json",
					title: "基准外规",
					pageCount: 1,
					chunkCount: 801,
					status: "ok",
				}),
			},
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("800");
	});

	/**
	 * 终审 I2:上面那道只信 E0 自报的 `chunk_count`,而 `documents-client.ts` 对非数字落 `0` ——
	 * E0 少回一个字段时它**恒不触发**,一份 5000 条款的产物长驱直入。本条锁的是本地复核那道:
	 * documents 桩仍回 `chunkCount: 2`(自报护栏因此必然不触发),超限的是实际解析出的条款数。
	 */
	it("终审 I2:E0 自报 chunk_count 正常但实际解析出 801 条条款 → 不产出结果(本地复核,不只信上游自报)", async () => {
		const clauses = Array.from({ length: 801 }, (_, i) => ({
			seq: i,
			clausePath: `第${i}条`,
			text: `外规第${i}条正文`,
		}));
		const { runtime } = await buildRuntime({
			modelReplies: [verdictReply([])],
			artifacts: { fetch: async () => ({ uploadId: "U1", title: "基准外规", docNo: undefined, clauses }) },
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("801");
		// 判别力:错误必须来自本地复核那条,不是上面那条自报护栏(它这次拿到的是 chunkCount=2)
		expect(result.errorMessage).toContain("以实际解析条数为准");
	});

	/**
	 * 终审 I1:阶段 5 的批数是 `ceil(pairs.length / batchSize)`,而 `doc_level` 降级让一条内规与
	 * 上传件全部条款成对 —— pairs 是乘积,阶段 2 那道 500 条上限完全管不住它。没有 MAX_PAIRS 时
	 * 这个 run 会一路跑到撞 maxTurns/maxCostUsd,两者都是 fail-closed 丢弃整个 output:钱烧完、
	 * 零产出。
	 */
	it("终审 I1:doc_level 扇出超过 MAX_PAIRS → 不产出结果,且一次模型调用都没发出", async () => {
		// 251 条内规 × 上传件 2 条条款 = 502 对 > MAX_PAIRS(500)。
		// 251 本身没超 MAX_OBLIGATIONS(500)—— 确保这条不是被阶段 2 那道护栏抢先拦下的。
		const n = 251;
		const { runtime } = await buildRuntime({
			obligationCount: n,
			modelReplies: [verdictReply([])],
			resolutionsRawOverride: {
				items: Array.from({ length: n }, (_, i) => ({
					chunk_id: `C-${i}`,
					// clause_path 为 null = M2 的映射粒度是文档级(规格 §5.2 的降级形态)
					source_laws: [{ doc_no: null, doc_title: "基准外规", clause_path: null, source_code: "X" }],
				})),
				rejected: [],
				unresolved: [],
			},
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("502");
		expect(result.errorMessage).toContain(`超过上限 ${MAX_PAIRS}`);
		// message 要指明病因是 doc_level 扇出,否则值班的人会去查阶段 2 的条数上限
		expect(result.errorMessage).toContain("doc_level");
		// 护栏在阶段 5 之前停下 —— 一次模型调用都没发生(这才是「不烧预算」那半边)
		expect(result.turns).toBe(0);
	});

	/**
	 * 终审 I3:`checkedCount` 取 `items.length`(按行数),而 metrics 按 `chunkId` 分组累加
	 * (按去重后的条数)—— 重复 chunk_id 会让守恒判负,而那条信息的文档写着「判负 = 代码 bug」,
	 * 值班的人会去查 TS 组装代码,病因却在 M1 的 JOIN。
	 */
	it("终审 I3:M1 返回重复 chunk_id → 点名 M1,不让它退化成一条误导性的「metrics 不自洽」", async () => {
		const row = (deonticType: string) => ({
			chunk_id: "C-0",
			clause_path: "内第0条",
			doc_title: "内规",
			doc_no: "内〔2026〕1号",
			deontic_type: deonticType,
			evidence: "应当",
			text: "内规第0条正文",
			source_code: "SC-0",
		});
		const { runtime } = await buildRuntime({
			modelReplies: [verdictReply([])],
			// 同一 chunk 挂了两条 is_obligation 标签(不同 deontic_type)—— 规格 §5.1 的 M1 SQL
			// 是 chunks JOIN clause_tags,这种情况会出重复行
			obligationsRawOverride: { items: [row("obligation"), row("prohibition")], total: 2, truncated: false },
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("list_internal_obligations 返回了重复 chunk_id");
		expect(result.errorMessage).toContain("C-0");
		// 🔴 判别力就在这条:病因指向 M1,不是笼统的守恒判负
		expect(result.errorMessage).not.toContain("metrics 不自洽");
	});

	it("list_internal_obligations 返回形状不对(缺 items 数组)→ 不产出结果", async () => {
		const { runtime } = await buildRuntime({
			obligationsRawOverride: { notItems: true },
			modelReplies: [verdictReply([])],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("items");
	});

	it("resolve_source_law 返回形状不对(缺 items 数组)→ 不产出结果", async () => {
		const { runtime } = await buildRuntime({
			resolutionsRawOverride: { notItems: true },
			modelReplies: [verdictReply([])],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("items");
	});

	it("Minor:list_internal_obligations 返回条数超过 MAX_OBLIGATIONS(500)→ 不产出结果(M1 未遵守 limit 参数)", async () => {
		// `limit: MAX_OBLIGATIONS` 只是请求里的一个字段,请求参数本身已经被上面「阶段 2 请求
		// 参数」那条测试锁住了 —— 这条测的是另一半:M1 完全可以无视这个参数、想回多少条就回多少
		// 条,runtime.ts 必须自己核实**返回值**,不能只信任"我传过 limit 了"。
		const items = Array.from({ length: MAX_OBLIGATIONS + 1 }, (_, i) => ({
			chunk_id: `C-${i}`,
			clause_path: `内第${i}条`,
			doc_title: "内规",
			doc_no: "内〔2026〕1号",
			deontic_type: "obligation",
			evidence: "应当",
			text: `内规第${i}条正文`,
			source_code: `SC-${i}`,
		}));
		const { runtime } = await buildRuntime({
			obligationsRawOverride: { items, total: items.length, truncated: false },
			modelReplies: [verdictReply([])],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain(String(MAX_OBLIGATIONS));
	});

	it("外规解析失败(artifacts.fetch 抛错)→ 不产出结果", async () => {
		const { runtime } = await buildRuntime({
			artifacts: {
				fetch: async () => {
					throw new Error("artifact 里没有任何条款块(chunk_type=clause)—— 上传件解析结果不可用");
				},
			},
			modelReplies: [verdictReply([])],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("条款块");
	});

	it("阶段 6 输出契约校验不过 → 不产出结果(explicit return 分支,不是 catch 分支)", async () => {
		// 加一个真实数据永远填不出来的必填字段,逼 Value.Check 判负 —— 直接命中
		// runtime.ts 里 `if (!checked.ok) return {...}` 那个显式分支,不经过 try/catch。
		const badSchema = { ...schema, required: [...schema.required, "doesNotExist"] };
		const { runtime } = await buildRuntime({
			outputContractSchemaOverride: badSchema,
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(result.errorMessage).toContain("输出契约校验失败");
		// 评审 Finding 4:这条命中的是 runInner() 里 `!checked.ok` 那个显式 return 分支 ——
		// 与上面「跑完六阶段」测的 completed 分支是两处不同的 currentUsage() 调用点,各自独立
		// 硬编码过 0,必须分别守。
		expect(result.usage.input).toBeGreaterThan(0);
		expect(result.usage.output).toBeGreaterThan(0);
	});
});

describe("PolicyCompareRuntime · limits(评审 Finding 1:limitState.tripped 接线 + runTimeoutMs 定时器)", () => {
	it('maxTurns 触顶 → status:"limit_exceeded",不产出结果,后续批次的模型调用从未发出', async () => {
		// 3 条义务、批大小 1 ⇒ 3 批。maxTurns:2 ⇒ 第 2 批的 turn_end 让 limits 插件把
		// limitState.tripped 置成 "maxTurns" 并调 ctx.abort();第 3 批循环开头的 checkPreempted()
		// 拦下 —— 第 3 批的 session.prompt() 从未真正发出。
		const { runtime, faux } = await buildRuntime({
			obligationCount: 3,
			batchSize: 1,
			limits: { maxTurns: 2 },
			modelReplies: [
				verdictReply([{ pairIndex: 0, state: "covered" }]),
				verdictReply([{ pairIndex: 1, state: "covered" }]),
				verdictReply([{ pairIndex: 2, state: "covered" }]), // 不会被消费
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("maxTurns");
		expect(result.output).toBeUndefined();
		expect(result.turns).toBe(2);
		// 独立佐证(同 A8 手法):faux 自己记的真实调用次数,不只信任 runtime 自报的 turns。
		expect(faux.state.callCount).toBe(2);
		// 评审 Finding 4:这条命中的是 run() 外层 catch 的 `tripped` 分支(status:"limit_exceeded")
		// ——与 completed / `!checked.ok` / 通用 __aborted__ 三个分支各自独立的 currentUsage()
		// 调用点不同。前两批模型调用真实发生过,usage 必须非零。
		expect(result.usage.input).toBeGreaterThan(0);
		expect(result.usage.output).toBeGreaterThan(0);
	});

	it('runTimeoutMs 超时 → status:"limit_exceeded",不产出结果', async () => {
		// 卡住阶段 2 的 list_internal_obligations(assembled.callTool 直打 tool.execute(),绕过
		// pi 的 agent loop,不受 session.abort() 影响)——runTimeoutMs 的 timer 必须独立于
		// limits 插件(它只在 turn_end 触发,阶段 2 根本不产生 turn_end)才能兜住这种"轮内卡死"。
		// 定时器触发后只是置位 limitState.tripped 并调 abortFn(),并不能打断这次直连的工具调用
		// 本身 —— 所以这里放行的时机要晚于 runTimeoutMs,让计时器先真正触发一次,再放行卡住的
		// 调用,好让 runInner() 走到下一个 checkPreempted() 去读到已经置位的 tripped。
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const { runtime, toolCalls } = await buildRuntime({
			modelReplies: [verdictReply([])],
			limits: { runTimeoutMs: 15 },
			gateObligations: gate,
		});
		const runPromise = runtime.run("比对");
		await new Promise((resolve) => setTimeout(resolve, 60)); // 远大于 15ms,确保定时器已触发
		releaseGate();
		const result = await runPromise;
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("runTimeout");
		expect(result.output).toBeUndefined();
		// 卡住的那次 list_internal_obligations 调用本身在放行后确实完成了(工具执行不受
		// session.abort() 影响),但 resolve_source_law 从未被调用 —— 下一个 checkPreempted()
		// (阶段 2→3 边界)在它之前拦下。
		expect(toolCalls).toEqual(["list_internal_obligations"]);
	});
});

describe("PolicyCompareRuntime · checkPreempted 判别力(评审 Finding 2:6 个检查点此前只有 1 个有测试守护)", () => {
	it("阶段 2→3 边界:abort 落在 list_internal_obligations 挂起期间,resolve_source_law 从未被调用", async () => {
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const { runtime, toolCalls } = await buildRuntime({
			modelReplies: [verdictReply([])],
			gateObligations: gate,
		});
		const runPromise = runtime.run("比对");
		// `!runtime.isIdle` 在 run() 一开始(甚至阶段 1 之前)就会变 true —— 不能拿它当"已经
		// 进了阶段 2"的信号,那样 abort() 可能在 checkPreempted() 读到阶段 2 之前就已经生效,
		// 测出来的其实是阶段 1→2 边界(已经被另一条用例覆盖),不是这条要测的阶段 2→3 边界。
		// toolCalls.push("list_internal_obligations") 在 execute() 里 await gate 之前就先执行,
		// 所以等它出现,才说明代码真的已经过了阶段 2 的 checkPreempted()、正卡在工具调用本身。
		await waitUntil(() => toolCalls.length === 1);
		await runtime.abort();
		releaseGate();
		const result = await runPromise;
		expect(result.status).toBe("aborted");
		expect(result.output).toBeUndefined();
		expect(toolCalls).toEqual(["list_internal_obligations"]);
	});

	it("阶段 3→4 边界:abort 落在 resolve_source_law 挂起期间,alignClauses 从未跑、阶段 5 从未发起模型调用", async () => {
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const { runtime, toolCalls, faux } = await buildRuntime({
			modelReplies: [verdictReply([])],
			gateResolutions: gate,
		});
		// ⚠ 只看 toolCalls/faux.state.callCount 不够判别力:就算把「阶段 3→4」这一处
		// checkPreempted() 单独删掉,alignClauses() 与它后面那句 stage("matching", 55, ...)
		// 也照样会先跑完,紧接着「阶段 5 循环内」那处 checkPreempted()(第一批开头)会替它把
		// abort 拦下来——toolCalls / faux.state.callCount 在两种情况下长得一模一样,测不出区别
		// (探针实测过:注释掉「阶段 3→4」那一处,这条用例原来的断言组合确实不会翻红)。
		// percent:55 那次 stage 事件只有在 alignClauses 真的跑过之后才会发出,拿它当判别信号:
		// 「阶段 3→4」的检查点存在 ⇒ abort 必须在 alignClauses 之前就被拦下 ⇒ percent:55 永远
		// 不会被发出。
		const events: RuntimeEvent[] = [];
		runtime.subscribe((e) => {
			if (e.type === "compare_stage") events.push(e);
		});
		const runPromise = runtime.run("比对");
		// 等 resolve_source_law 真的已经开始执行(toolCalls 里出现第二项)再 abort,才是在测
		// 阶段 3→4 边界,不是提前撞上阶段 2→3 边界。
		await waitUntil(() => toolCalls.length === 2);
		await runtime.abort();
		releaseGate();
		const result = await runPromise;
		expect(result.status).toBe("aborted");
		expect(result.output).toBeUndefined();
		expect(toolCalls).toEqual(["list_internal_obligations", "resolve_source_law"]);
		// alignClauses 是纯代码、阶段 4→5 之间没有可挂的 await 点 —— 唯一能验证"阶段 5 真的没跑"
		// 的办法是看模型压根没被调用过(faux 自己的调用计数,独立于 runtime.ts 的 modelCalls)。
		expect(faux.state.callCount).toBe(0);
		const percents = events.map((e) => (e.payload as { percent: number }).percent);
		expect(percents).not.toContain(55);
	});

	it("阶段 5 循环内边界:abort 落在两批之间(第一批已完整返回、第二批还没发起)", async () => {
		// 与下面"阶段 5→6 边界"是两个互斥的场景:那条测的是 abort 落在**某一批 prompt() 期间**
		// (fail-closed 闸门,循环已经跑完、没有下一次循环内检查能拦住它);这条测的是 abort 落在
		// **两批完整调用之间**——循环内检查点是"两批之间"唯一能让 abort 生效的地方。
		//
		// 用 rawModelResponses 的工厂函数在第一批的回复真正返回之前(faux 的 stream() 里
		// `await step(...)` 那一刻)同步调用 abort()——此时第一批的 prompt() 已经在飞、还没
		// resolve,第二批的 checkPreempted() 还没到。factory 通过 runtimeRef 引用 runtime,
		// 用 `let` 而不是直接闭包捕获 buildRuntime() 的返回值,避免"传参时 runtime 还不存在"的
		// 先有鸡还是先有蛋问题——factory 本身要等到 runtime.run() 真正跑到阶段 5 才会被调用,
		// 届时 runtimeRef 早已被下面的赋值语句填上。
		let runtimeRef: Awaited<ReturnType<typeof buildRuntime>>["runtime"] | undefined;
		const { runtime, faux } = await buildRuntime({
			obligationCount: 2,
			batchSize: 1, // 两条义务、批大小 1 ⇒ 两批
			modelReplies: [],
			rawModelResponses: [
				() => {
					runtimeRef?.abort();
					return fauxAssistantMessage(verdictReply([{ pairIndex: 0, state: "covered" }]));
				},
				fauxAssistantMessage(verdictReply([{ pairIndex: 1, state: "covered" }])),
			],
		});
		runtimeRef = runtime;
		const result = await runtime.run("比对");
		expect(result.status).toBe("aborted");
		expect(result.output).toBeUndefined();
		expect(result.turns).toBe(1); // 只有第一批真正发生
		expect(faux.state.callCount).toBe(1); // 第二批从未被 faux 记到调用
	});

	it("阶段 5→6 边界(fail-closed 闸门):abort 落在最后一批 prompt() 期间,即便该批正常返回完整判定也不产出结果", async () => {
		// 这是评审 Finding 2 点名的那道闸:session.prompt() 被 abort 打断时不一定抛错(pi 可能让
		// 它正常返回,哪怕只是部分/被截断的文本)——若没有这道阶段 5→6 之间的 checkPreempted(),
		// 已经拿到的、看起来完全合法的判定会被直接组装成 completed 结果送出去。用一个卡住的
		// 工厂函数模拟"prompt() 正在飞"这个窗口,在窗口期间 abort,再放行让它正常返回一份
		// **完整合法**的判定文本(不是抛错、不是空文本)——即便如此,也必须被拦下。
		let releasePrompt: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const { runtime, toolCalls } = await buildRuntime({
			modelReplies: [],
			rawModelResponses: [
				async () => {
					await gate;
					return fauxAssistantMessage(
						verdictReply([
							{ pairIndex: 0, state: "covered" },
							{ pairIndex: 1, state: "covered" },
						]),
					);
				},
			],
		});
		const runPromise = runtime.run("比对");
		// 两次工具调用都已完成 ⇒ 已经过了阶段 3→4 边界、进入阶段 5,batch 1 的 prompt() 正被
		// gate 卡住(gate 在我们主动 releasePrompt() 之前永远不 resolve,不依赖任何计时窗口)。
		await waitUntil(() => toolCalls.length === 2);
		await runtime.abort();
		releasePrompt();
		const result = await runPromise;
		expect(result.status).toBe("aborted");
		expect(result.output).toBeUndefined();
		expect(result.turns).toBe(1); // 这一批模型调用确实真实发生过,不是硬编码 0
		// 评审 Finding 4:这条命中的是 run() 外层 catch 的通用 __aborted__ 分支,与 limit_exceeded
		// 那条 catch 分支是两处不同的 currentUsage() 调用点——这一批模型调用真实发生过,usage
		// 必须非零。
		expect(result.usage.input).toBeGreaterThan(0);
		expect(result.usage.output).toBeGreaterThan(0);
	});
});

describe("PolicyCompareRuntime · Minor(重入保护 / 终态 compare_stage 事件)", () => {
	it("重入保护:run() 被并发调用时立即拒绝,不覆盖前一个 run 的状态", async () => {
		let releaseGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const { runtime } = await buildRuntime({
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
			documents: {
				process: async () => {
					await gate;
					return {
						uploadId: "U1",
						artifactKey: "artifact/U1.json",
						title: "基准外规",
						pageCount: 1,
						chunkCount: 2,
						status: "ok",
					};
				},
			},
		});
		const firstRun = runtime.run("比对一");
		await waitUntil(() => !runtime.isIdle);
		await expect(runtime.run("比对二")).rejects.toThrow(/并发调用/);
		releaseGate();
		const result = await firstRun;
		// 第一个 run 没有被第二次调用打断,正常跑完。
		expect(result.status).toBe("completed");
	});

	it("失败路径补终态 compare_stage 事件(percent=100、current===total)—— 进度端点不再冻结在中途百分比", async () => {
		const events: RuntimeEvent[] = [];
		const { runtime } = await buildRuntime({
			outputContractSchemaOverride: null, // 逼阶段 6 的 Value.Check 直接抛,走 run() 的 catch 分支
			modelReplies: [
				verdictReply([
					{ pairIndex: 0, state: "covered" },
					{ pairIndex: 1, state: "covered" },
				]),
			],
		});
		runtime.subscribe((e) => {
			if (e.type === "compare_stage") events.push(e);
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("error");
		const last = events.at(-1)!.payload as { percent: number; current: number; total: number; message: string };
		expect(last.percent).toBe(100);
		expect(last.current).toBe(last.total);
		expect(last.message).toBe(result.errorMessage);
	});
});

describe("PolicyCompareRuntime · 终审 C1(跨批 pairIndex 覆盖:判定挂到错误的条款对上)", () => {
	/**
	 * 🔴 本轮最严重那条的回归锁。
	 *
	 * 场景:4 对条款、batchSize=2 ⇒ 2 批。fake 模型**每批都从 0 编号**(system.md 的示例一度
	 * 就是这么诱导的)。没有区间过滤时,第 2 批回的 0/1 会盖掉第 1 批那两对的判定,而两侧正文
	 * 由代码从各自的 pair 填 —— schema、四条反幻觉全部照过,输出是一张看起来完全合规、判定却
	 * 张冠李戴的表。
	 *
	 * 三组断言分别锁住修复的三个面:①判定没挂错 ②越界的进 gaps 不静默丢 ③没拿到判定的计 unmatched。
	 */
	it("模型每批都从 0 编号:判定不挂到别的 pair 上,越界进 gaps,未获判定的计 unmatched", async () => {
		const { runtime } = await buildRuntime({
			obligationCount: 4,
			batchSize: 2,
			modelReplies: [
				// 第 1 批(全局 pairIndex 0、1):编号正确
				verdictReply([
					{ pairIndex: 0, state: "missing", gap: "第一批的缺口", suggestion: "第一批的建议" },
					{ pairIndex: 1, state: "covered" },
				]),
				// 第 2 批(全局 pairIndex 2、3):模型照示例从 0 重新编号
				verdictReply([
					{ pairIndex: 0, state: "conflict", conflictType: "第二批的冲突", gap: "x", suggestion: "y" },
					{ pairIndex: 1, state: "conflict", conflictType: "第二批的冲突", gap: "x", suggestion: "y" },
				]),
			],
		});
		const result = await runtime.run("比对");
		expect(result.status).toBe("completed");
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, "")) as {
			rows: Array<{ conflictType: string; judgement: string; basis: { internalChunkId: string } }>;
			metrics: Record<string, number>;
			gaps: string[];
		};

		// ① 第 2 批的判定一条都没落到 pair 0/1 上。rows 只能有 C-0 那条 missing;
		//    没修之前这里是两行 conflict(「第二批的冲突」),挂在 C-0 / C-1 上。
		expect(body.rows.map((r) => r.basis.internalChunkId)).toEqual(["C-0"]);
		expect(body.rows[0].judgement).toBe("缺失要求");
		expect(body.rows.some((r) => r.conflictType === "第二批的冲突")).toBe(false);
		expect(body.metrics.conflict).toBe(0);

		// ② 越界判定进 gaps,并带上实际收到的值与本批合法区间
		const discarded = body.gaps.filter((g) => g.includes("本批之外的 pairIndex"));
		expect(discarded).toHaveLength(2);
		expect(discarded.join("\n")).toContain("收到 0");
		expect(discarded.join("\n")).toContain("收到 1");
		expect(discarded.join("\n")).toContain("[2, 4)");

		// ③ 第 2 批那两对因此没有判定 → 计入 unmatched,并各自写一条 gap
		expect(body.metrics.unmatched).toBe(2);
		expect(body.gaps.join("\n")).toContain("C-2 未获模型判定");
		expect(body.gaps.join("\n")).toContain("C-3 未获模型判定");
		// 守恒仍然成立(阶段 6 的校验独立再判一次):1 missing + 0 conflict + 1 covered + 2 unmatched = 4
		expect(body.metrics.checked).toBe(4);
		expect(body.metrics.missing + body.metrics.conflict + body.metrics.covered + body.metrics.unmatched).toBe(4);
	});
});
