import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ProviderProfile } from "../../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../../src/runtime/default-plugins.ts";
import type { ArtifactStore } from "../../src/runtime/policy-compare/artifact-store.ts";
import type { DocumentsClient } from "../../src/runtime/policy-compare/documents-client.ts";
import { createPolicyCompareRuntime } from "../../src/runtime/policy-compare/runtime.ts";
import type { RuntimeLimits } from "../../src/spec/types.ts";
import { ToolsetRegistry } from "../../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./faux.ts";

/**
 * `policy-compare-runtime.test.ts` 与 `policy-compare-acceptance.test.ts` 共用的构造器。
 * **抽出来,不要复制**——两份漂了之后两个文件会对同一条不变量给出不同结论(比如
 * `MAX_OBLIGATIONS` 的默认值,或 fake M1/M2 的返回形状)。
 */

export const profile: ProviderProfile = {
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

// 不导出:只有 buildRuntime 自己用来喂默认的 documents/artifacts 桩。两个消费方(runtime 测试、
// 验收测试)需要的是「外规条款正文是什么」这个事实,用字面量断言(比对 buildRuntime 产出的行表)
// 比 import 这个 fixture 对象再拆字段更直接——留着 export 会变成没人用的死导出。
const ARTIFACT = {
	upload_id: "U1",
	doc: { title: "基准外规", page_count: 1, chunk_count: 2 },
	chunks: [
		{ seq: 0, clause_path: "第五条", chunk_type: "clause", text: "外规第五条正文应当", is_table: false },
		{ seq: 1, clause_path: "第十条", chunk_type: "clause", text: "外规第十条正文不得", is_table: false },
	],
	markdown: "",
};

export interface HarnessOpts {
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
	/** 批量候选检索工具直接返回此响应，用于验证外规→内规实际检索链的 fail-closed 语义。 */
	candidateBatchRawOverride?: unknown;
	/** 反向批量检索工具直接返回此响应，用于验证内规→外规语义覆盖链。 */
	externalCandidateBatchRawOverride?: unknown;
	/** 批量候选检索工具直接抛出，模拟 audit-ai MCP 的 JSON-RPC / 上游失败。 */
	candidateBatchThrows?: string;
	/** 让 resolve_source_law 直接回这个形状,测 toResolutions 的 fail-closed。 */
	resolutionsRawOverride?: unknown;
	/** 覆盖 outputContractSchema —— 用于让阶段 6 校验必然判负。 */
	outputContractSchemaOverride?: unknown;
	/** 覆盖 spec.limits —— 用于测 maxTurns/runTimeoutMs 触顶。缺省是宽松值(不会触发)。 */
	limits?: RuntimeLimits;
	/** list_internal_obligations 的 execute() 在返回前先 await 这个 —— 用来在阶段 2 的工具
	 *  调用悬而未决时人为制造一个可控窗口,测「阶段 2→3 边界」的 checkPreempted()。 */
	gateObligations?: Promise<void>;
	/** 同上,卡在 resolve_source_law 的 execute() 返回前 —— 测「阶段 3→4 边界」。 */
	gateResolutions?: Promise<void>;
	/** 绕开 `modelReplies` 到 `fauxAssistantMessage` 的直接映射,直接把 FauxResponseStep[] 传给
	 *  `faux.setResponses`——某几项可以是返回 Promise 的工厂函数,用来卡住某一批的
	 *  `session.prompt()`,测「阶段 5 循环内」与「阶段 5→6 边界」这两个 checkPreempted()。 */
	rawModelResponses?: unknown[];
	/** 让 documents.process 直接抛错(A7-1)—— 不用另起一个完整的 `documents` 覆盖对象。 */
	documentsThrows?: string;
	/** 让 list_internal_obligations 回一个没有 items 数组的畸形响应(A7-2 的另一种触发方式,
	 *  区别于 `obligationsRawOverride` 的自由形状:这里固定成「总数字段在、items 缺席」这一种
	 *  最贴近真实 M1 故障的形状)。 */
	obligationsMalformed?: boolean;
	/** 让 resolve_source_law 的 execute() 直接抛(模拟 M2 侧 JSON-RPC error,A7-3)。 */
	resolveThrows?: string;
	/** 让 artifacts.fetch 走真实的 `parseArtifact`,喂一份 `chunks: []` 的产物 —— 触发的是
	 *  `parseArtifact` 里那条真实的「零条款块」校验(A7-4),不是伪造一个直接 throw 的假实现。 */
	artifactNoClauses?: boolean;
	/** 与默认 payload 浅合并后传入 —— 用于测装配期对 payload 形状的拒绝(比如 A7-5 的
	 *  `scope.organizations` 非空)。 */
	payloadOverride?: Record<string, unknown>;
}

/**
 * 每次 `buildRuntime()` 起的 faux harness / runtime 都要在测试结束后清理(临时目录、faux
 * provider 注册)。清理队列放在模块级而不是让每个调用方各带一份 —— 两个测试文件各自 `import`
 * 本模块时,vitest 默认按文件隔离模块实例,不会互相污染;每个文件只需在自己的 `afterEach`
 * 里调一次 `cleanupPolicyCompareHarnesses()`,不用在每条用例里手动记账。
 */
let cleanups: Array<() => Promise<void>> = [];

export async function cleanupPolicyCompareHarnesses(): Promise<void> {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
}

export async function buildRuntime(o: HarnessOpts) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses((o.rawModelResponses ?? o.modelReplies.map((r) => fauxAssistantMessage(r))) as never);

	const n = o.obligationCount ?? 2;
	const paths = ["第五条", "第十条"];
	const toolCalls: string[] = [];
	const candidateBatchArgs: Record<string, unknown>[] = [];
	const externalCandidateBatchArgs: Record<string, unknown>[] = [];
	const obligationsArgs: Record<string, unknown>[] = [];
	const resolutionsArgs: Record<string, unknown>[] = [];
	const registry = new ToolsetRegistry();
	registry.register("pc", async () => [
		{
			name: "retrieve_internal_candidates_batch",
			label: "retrieve_internal_candidates_batch",
			description: "faux",
			parameters: Type.Object({ clauses: Type.Array(Type.Object({ clause_path: Type.Optional(Type.String()), text: Type.String() })) }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				toolCalls.push("retrieve_internal_candidates_batch");
				candidateBatchArgs.push(params);
				if (o.gateObligations) await o.gateObligations;
				if (o.candidateBatchThrows) throw new Error(o.candidateBatchThrows);
				const clauses = params.clauses as Array<Record<string, unknown>>;
				if (o.obligationsMalformed) {
					const body = JSON.stringify({ total: 0 });
					return { output: body, content: body };
				}
				if (o.candidateBatchRawOverride !== undefined) {
					const body = JSON.stringify(o.candidateBatchRawOverride);
					return { output: body, content: body };
				}
				const items = clauses.map((_, index) => ({
					query_index: index,
					candidates: Array.from({ length: Math.floor((n + clauses.length - 1 - index) / clauses.length) }, (_, slot) => {
						const candidateIndex = index + slot * clauses.length;
						return {
							chunk_id: `C-${candidateIndex}`,
							clause_path: `内第${candidateIndex}条`,
							doc_title: "内规",
							doc_no: "内〔2026〕1号",
							text: `内规第${candidateIndex}条正文`,
							source_code: `SC-${candidateIndex}`,
							score: 0.9,
						};
					}),
					error: null,
				}));
				const body = JSON.stringify({ items, total: items.length });
				return { output: body, content: body };
			},
		} as never,
		{
			name: "retrieve_external_candidates_batch",
			label: "retrieve_external_candidates_batch",
			description: "faux",
			parameters: Type.Object({ clauses: Type.Array(Type.Object({ clause_path: Type.Optional(Type.String()), text: Type.String() })) }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				toolCalls.push("retrieve_external_candidates_batch");
				externalCandidateBatchArgs.push(params);
				const clauses = params.clauses as Array<Record<string, unknown>>;
				const body = JSON.stringify(
					o.externalCandidateBatchRawOverride ?? {
						items: clauses.map((_, index) => ({
							query_index: index,
							candidates: [
								{
									chunk_id: `EXT-${index}`,
									clause_path: `外第${index}条`,
									doc_title: "外规",
									doc_no: "外〔2026〕1号",
									text: `外规第${index}条正文应当`,
									source_code: `EXT-SC-${index}`,
									score: 0.9,
								},
							],
							error: null,
						})),
						total: clauses.length,
					},
				);
				return { output: body, content: body };
			},
		} as never,
		{
			name: "list_internal_obligations",
			label: "list_internal_obligations",
			description: "faux",
			parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
			execute: async (_id: string, params: Record<string, unknown>) => {
				toolCalls.push("list_internal_obligations");
				obligationsArgs.push(params);
				if (o.gateObligations) await o.gateObligations;
				if (o.obligationsMalformed) {
					const body = JSON.stringify({ total: 0 });
					return { output: body, content: body };
				}
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
			parameters: Type.Object({
				chunk_ids: Type.Array(Type.String()),
				target_document: Type.Optional(
					Type.Object({ title: Type.String(), doc_no: Type.Union([Type.String(), Type.Null()]) }),
				),
			}),
			execute: async (_id: string, params: Record<string, unknown>) => {
				toolCalls.push("resolve_source_law");
				resolutionsArgs.push(params);
				if (o.gateResolutions) await o.gateResolutions;
				if (o.resolveThrows) {
					throw new Error(o.resolveThrows);
				}
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

	// 提到局部变量再用:`o.documentsThrows` 是可选属性,直接在下面的嵌套闭包里访问不会被
	// TS 保留窄化(闭包可能在检查之后的任意时刻才执行),会报 `string | undefined` 传不进
	// `Error(message: string)`。
	const documentsThrows = o.documentsThrows;
	const documents: DocumentsClient =
		o.documents ??
		(documentsThrows !== undefined
			? {
					process: async () => {
						throw new Error(documentsThrows);
					},
				}
			: {
					process: async () => ({
						uploadId: "U1",
						artifactKey: "artifact/U1.json",
						title: "基准外规",
						pageCount: 1,
						chunkCount: 2,
					status: "ok",
				}),
				getInternalDocument: async () => ({
					uploadId: "library:INT-DV-1",
					title: "知识库内规",
					clauses: [
						{ seq: 0, clausePath: "第一条", text: "内规第一条应当落实外规要求" },
						{ seq: 1, clausePath: "第二条", text: "内规第二条不得违反规定" },
					],
				}),
				checkInternalReferenceVersions: async () => ({
					compareType: "internal_to_external",
					metrics: { checked: 0, missing: 0, conflict: 0, covered: 0, unmatched: 0, linked: 0 },
					rows: [],
					gaps: [],
					finish_reason: "stop",
				}),
			});

	const artifacts: ArtifactStore =
		o.artifacts ??
		(o.artifactNoClauses
			? {
					fetch: async () => {
						const { parseArtifact } = await import("../../src/runtime/policy-compare/artifact-store.ts");
						return parseArtifact(JSON.stringify({ ...ARTIFACT, chunks: [] }));
					},
				}
			: {
					fetch: async () => {
						const { parseArtifact } = await import("../../src/runtime/policy-compare/artifact-store.ts");
						return parseArtifact(JSON.stringify(ARTIFACT));
					},
				});

	const runtime = await createPolicyCompareRuntime({
		spec: {
			id: "policy-compare-coverage",
			model: { role: "main" },
			toolset: "pc",
			tools: ["retrieve_internal_candidates_batch", "retrieve_external_candidates_batch"],
			limits: o.limits ?? { maxTurns: 100, runTimeoutMs: 1_800_000 },
		},
		profile,
		registry: createDefaultPluginRegistry(),
		toolsets: registry,
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		// ⚠ 用 `!== undefined` 而不是 `??`:`??` 对 `null` 也会回退,而其中一条测试故意传
		// `outputContractSchemaOverride: null` 去逼 `Value.Check` 抛错 —— 用 `??` 会让那个
		// `null` 静默被换回真 schema,测试名不副实。
		outputContractSchema:
			o.outputContractSchemaOverride !== undefined ? o.outputContractSchemaOverride : defaultOutputContractSchema,
		payload: {
			external: { objectKey: "upload/U1/a.pdf", uploadId: "U1", filename: "a.pdf" },
			scope: {},
			...o.payloadOverride,
		},
		documents,
		artifacts,
		batchSize: o.batchSize,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	});
	cleanups.push(() => runtime.dispose());
	return { runtime, toolCalls, candidateBatchArgs, externalCandidateBatchArgs, obligationsArgs, resolutionsArgs, faux: harness.faux };
}

export const verdictReply = (items: unknown[]) => `\`\`\`json\n${JSON.stringify({ verdicts: items })}\n\`\`\``;

/** `outputContractSchema` 的缺省值 —— `buildRuntime` 自己内部用,调用方要另外断言 schema
 *  校验时各自独立 `readFileSync` 同一份文件(两个测试文件本来就都这么做,读一份静态 JSON
 *  文件不是会漂移的行为,不值得为了去重而多绕一层导出)。 */
const defaultOutputContractSchema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../specs/policy-compare/coverage.schema.json", import.meta.url)), "utf8"),
);
