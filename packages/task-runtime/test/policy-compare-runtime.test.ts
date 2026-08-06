import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import type { RuntimeEvent } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { ArtifactStore } from "../src/runtime/policy-compare/artifact-store.ts";
import type { DocumentsClient } from "../src/runtime/policy-compare/documents-client.ts";
import {
	createPolicyCompareRuntime,
	DEFAULT_BATCH_SIZE,
	MAX_OBLIGATIONS,
	type PolicyCompareRuntimeOptions,
	parseCoveragePayload,
} from "../src/runtime/policy-compare/runtime.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const ok = {
	external: { objectKey: "upload/U1/a.pdf", uploadId: "U1", filename: "a.pdf" },
	scope: { organizations: [], bizDomains: ["费用报销"], chapters: ["第二章"] },
	outputTypes: ["summary_diff", "missing_items", "partial_items", "conflict_items"],
};

describe("parseCoveragePayload", () => {
	it("合法 payload 通过", () => {
		expect(parseCoveragePayload(ok).external.uploadId).toBe("U1");
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
});

const schema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-compare/coverage.schema.json", import.meta.url)), "utf8"),
);

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

const ARTIFACT = {
	upload_id: "U1",
	doc: { title: "基准外规", page_count: 1, chunk_count: 2 },
	chunks: [
		{ seq: 0, clause_path: "第五条", chunk_type: "clause", text: "外规第五条正文", is_table: false },
		{ seq: 1, clause_path: "第十条", chunk_type: "clause", text: "外规第十条正文", is_table: false },
	],
	markdown: "",
};

interface HarnessOpts {
	modelReplies: string[];
	obligationCount?: number;
	unresolvedIds?: string[];
	batchSize?: number;
	/** M2 的 rejected 明细(与 unresolved 是两个不同的字段,都要进 extraGaps)。 */
	rejectedIds?: string[];
	/** 阶段 2 命中的库内真实总条数;缺省与 obligationCount 相同(未截断)。 */
	libraryTotal?: number;
	/** 阶段 2 是否撞到 limit 被截断。 */
	truncated?: boolean;
	/** 覆盖 documents.process 的默认实现 —— 用于触发切块数超上限等失败路径。 */
	documents?: DocumentsClient;
	/** 覆盖 artifacts.fetch 的默认实现 —— 用于触发外规解析失败路径。 */
	artifacts?: ArtifactStore;
	/** 让 list_internal_obligations 直接回这个形状(绕开正常生成),测 toObligations 的 fail-closed。 */
	obligationsRawOverride?: unknown;
	/** 让 resolve_source_law 直接回这个形状,测 toResolutions 的 fail-closed。 */
	resolutionsRawOverride?: unknown;
	/** 覆盖 outputContractSchema —— 用于让阶段 6 校验必然判负。 */
	outputContractSchemaOverride?: unknown;
}

async function buildRuntime(o: HarnessOpts) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses(o.modelReplies.map((r) => fauxAssistantMessage(r)) as never);

	const n = o.obligationCount ?? 2;
	const paths = ["第五条", "第十条"];
	const toolCalls: string[] = [];
	const obligationsArgs: Record<string, unknown>[] = [];
	const resolutionsArgs: Record<string, unknown>[] = [];
	const registry = new ToolsetRegistry();
	registry.register("pc", async () => [
		{
			name: "list_internal_obligations",
			label: "list_internal_obligations",
			description: "faux",
			parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				toolCalls.push("list_internal_obligations");
				obligationsArgs.push(params);
				if (o.obligationsRawOverride !== undefined) {
					const body = JSON.stringify(o.obligationsRawOverride);
					return { output: body, content: body };
				}
				const items = Array.from({ length: n }, (_, i) => ({
					chunk_id: `C-${i}`,
					clause_path: `内第${i}条`,
					doc_title: "内规",
					doc_no: "内〔2026〕1号",
					deontic_type: "obligation",
					evidence: "应当",
					text: `内规第${i}条正文`,
					source_code: `SC-${i}`,
				}));
				const body = JSON.stringify({
					items,
					total: o.libraryTotal ?? n,
					truncated: o.truncated ?? false,
				});
				return { output: body, content: body };
			},
		} as never,
		{
			name: "resolve_source_law",
			label: "resolve_source_law",
			description: "faux",
			parameters: Type.Object({ chunk_ids: Type.Array(Type.String()) }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				toolCalls.push("resolve_source_law");
				resolutionsArgs.push(params);
				if (o.resolutionsRawOverride !== undefined) {
					const body = JSON.stringify(o.resolutionsRawOverride);
					return { output: body, content: body };
				}
				const ids = params.chunk_ids as string[];
				const unresolved = new Set(o.unresolvedIds ?? []);
				const items = ids
					.filter((cid) => !unresolved.has(cid))
					.map((cid, i) => ({
						chunk_id: cid,
						source_laws: [
							{ doc_no: null, doc_title: "基准外规", clause_path: paths[i % paths.length], source_code: "X" },
						],
					}));
				const body = JSON.stringify({ items, rejected: o.rejectedIds ?? [], unresolved: [...unresolved] });
				return { output: body, content: body };
			},
		} as never,
	]);

	const runtime = await createPolicyCompareRuntime({
		spec: {
			id: "policy-compare-coverage",
			model: { role: "main" },
			toolset: "pc",
			tools: ["list_internal_obligations", "resolve_source_law"],
			limits: { maxTurns: 100, runTimeoutMs: 1_800_000 },
		},
		profile,
		registry: createDefaultPluginRegistry(),
		toolsets: registry,
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		// ⚠ 用 `!== undefined` 而不是 `??`:`??` 对 `null` 也会回退,而其中一条测试故意传
		// `outputContractSchemaOverride: null` 去逼 `Value.Check` 抛错 —— 用 `??` 会让那个
		// `null` 静默被换回真 schema,测试名不副实。
		outputContractSchema: o.outputContractSchemaOverride !== undefined ? o.outputContractSchemaOverride : schema,
		payload: { external: { objectKey: "upload/U1/a.pdf", uploadId: "U1", filename: "a.pdf" }, scope: {} },
		documents: o.documents ?? {
			process: async () => ({
				uploadId: "U1",
				artifactKey: "artifact/U1.json",
				title: "基准外规",
				pageCount: 1,
				chunkCount: 2,
				status: "ok",
			}),
		},
		artifacts: o.artifacts ?? {
			fetch: async () => {
				const { parseArtifact } = await import("../src/runtime/policy-compare/artifact-store.ts");
				return parseArtifact(JSON.stringify(ARTIFACT));
			},
		},
		batchSize: o.batchSize,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	});
	cleanups.push(() => runtime.dispose());
	return { runtime, toolCalls, obligationsArgs, resolutionsArgs, faux: harness.faux };
}

const verdictReply = (items: unknown[]) => "```json\n" + JSON.stringify({ verdicts: items }) + "\n```";

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
	it("跑完六阶段并产出合规行表", async () => {
		const { runtime, toolCalls } = await buildRuntime({
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
		const body = JSON.parse(result.output!.replace(/```json\n|\n```/g, ""));
		expect(body.compareType).toBe("external_to_internal");
		expect(body.rows).toHaveLength(1);
		expect(body.rows[0].externalClause).toBe("外规第五条正文");
		expect(body.metrics.checked).toBe(2);
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
		expect(body.gaps.join("\n")).toContain("C-1");
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
		// 阶段 2 的 checkAborted() 在 list_internal_obligations 之前拦下 —— 工具从未被调用。
		expect(toolCalls).toEqual([]);
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
	});
});
