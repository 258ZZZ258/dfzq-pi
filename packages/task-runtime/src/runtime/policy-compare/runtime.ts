import { randomUUID } from "node:crypto";
import type { ProviderProfile } from "../../env/provider-profile.ts";
import type { RuntimeLimits, RuntimeSpec } from "../../spec/types.ts";
import type { ToolsetRegistry } from "../../toolsets/registry.ts";
import { type Assembled, type AssembleOptions, assemble, type PluginToolCallEvent } from "../assembler.ts";
import type { LimitKind, LimitState, RunOptions, RunResult, Runtime, RuntimeEvent } from "../contract.ts";
import type { PluginContext, PluginRegistry } from "../plugin-registry.ts";
import { alignClauses } from "./align.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { buildCoverageResult } from "./assemble.ts";
import type { DocumentsClient } from "./documents-client.ts";
import type { CoveragePayload, InternalObligation, SourceLawResolution, Verdict } from "./types.ts";
import { validateCoverageResult } from "./validate-result.ts";
import { batchPairs, parseVerdicts, renderBatchPrompt } from "./verdicts.ts";

/** 规格 §3.5 的护栏定值。 */
export const MAX_BATCH_SIZE = 20;
export const DEFAULT_BATCH_SIZE = 8;
export const MAX_OBLIGATIONS = 500;
export const MAX_EXTERNAL_CHUNKS = 800;

const ALL_OUTPUT_TYPES = ["summary_diff", "missing_items", "partial_items", "conflict_items"];

/**
 * `POST /runs` 的 `payload` 形状校验。**装配期就跑**,不拖到阶段 5(规格 §7.1)。
 *
 * 两个字段本轮不生效但必须显式拒绝(规格 §3.1):
 * - `scope.organizations` —— PG 无对应列,静默忽略一个范围收窄参数等于越权返回
 * - `outputTypes` —— 协议 §3.4 规定它恒为全选;收到别的值说明上游理解有偏差,要炸出来
 */
export function parseCoveragePayload(raw: unknown): CoveragePayload {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("payload 必须是 JSON 对象");
	}
	const p = raw as Record<string, unknown>;
	const external = p.external as Record<string, unknown> | undefined;
	for (const key of ["objectKey", "uploadId", "filename"]) {
		if (!external || typeof external[key] !== "string" || external[key] === "") {
			throw new Error(`payload.external.${key} 必填且必须是非空字符串`);
		}
	}
	const scope = (p.scope ?? {}) as Record<string, unknown>;
	const orgs = scope.organizations;
	if (Array.isArray(orgs) && orgs.length > 0) {
		throw new Error("payload.scope.organizations 非空 —— 「适用组织」维度本轮无可用数据列,未实现(不静默忽略)");
	}
	const outputTypes = p.outputTypes;
	if (outputTypes !== undefined) {
		if (
			!Array.isArray(outputTypes) ||
			outputTypes.length !== ALL_OUTPUT_TYPES.length ||
			!ALL_OUTPUT_TYPES.every((t) => outputTypes.includes(t))
		) {
			throw new Error(`payload.outputTypes 只接受全选(${ALL_OUTPUT_TYPES.join("、")})`);
		}
	}
	return {
		external: {
			objectKey: external!.objectKey as string,
			uploadId: external!.uploadId as string,
			filename: external!.filename as string,
		},
		scope: {
			organizations: [],
			bizDomains: Array.isArray(scope.bizDomains) ? (scope.bizDomains as string[]) : undefined,
			chapters: Array.isArray(scope.chapters) ? (scope.chapters as string[]) : undefined,
			effectiveDateRange: Array.isArray(scope.effectiveDateRange)
				? (scope.effectiveDateRange as [string, string])
				: undefined,
		},
		outputTypes: ALL_OUTPUT_TYPES,
	};
}

export interface PolicyCompareRuntimeOptions {
	spec: RuntimeSpec;
	profile: ProviderProfile;
	registry: PluginRegistry;
	toolsets: ToolsetRegistry;
	cwd: string;
	agentDir: string;
	/** 本 spec 的 outputContract schema。缺失即拒绝构造 —— 阶段 6 每次都要用它判。 */
	outputContractSchema: unknown;
	payload: unknown;
	documents: DocumentsClient;
	artifacts: ArtifactStore;
	batchSize?: number;
	skillPaths?: string[];
	modelOverride?: AssembleOptions["modelOverride"];
}

type Stage = "extracting" | "matching" | "judging" | "assembling";

/** 从 M1 的工具返回里取义务条款。形状不对即抛 —— 阶段 2 拿不到东西不能当成「零义务」。 */
function toObligations(raw: unknown): { items: InternalObligation[]; total: number; truncated: boolean } {
	const r = raw as { items?: unknown; total?: unknown; truncated?: unknown } | null;
	if (!r || !Array.isArray(r.items)) {
		throw new Error("list_internal_obligations 返回缺少 items 数组");
	}
	const items = r.items.map((it) => {
		const row = it as Record<string, unknown>;
		return {
			chunkId: String(row.chunk_id ?? ""),
			clausePath: typeof row.clause_path === "string" ? row.clause_path : null,
			docTitle: typeof row.doc_title === "string" ? row.doc_title : null,
			docNo: typeof row.doc_no === "string" ? row.doc_no : null,
			deonticType: (row.deontic_type ?? "obligation") as InternalObligation["deonticType"],
			evidence: typeof row.evidence === "string" ? row.evidence : null,
			text: String(row.text ?? ""),
			sourceCode: typeof row.source_code === "string" ? row.source_code : null,
		} satisfies InternalObligation;
	});
	return {
		items,
		total: typeof r.total === "number" ? r.total : items.length,
		truncated: r.truncated === true,
	};
}

/** 从 M2 的工具返回里取映射。`rejected` / `unresolved` 原样带出,由调用方写进 gaps。 */
function toResolutions(raw: unknown): {
	items: SourceLawResolution[];
	rejected: string[];
	unresolved: string[];
} {
	const r = raw as { items?: unknown; rejected?: unknown; unresolved?: unknown } | null;
	if (!r || !Array.isArray(r.items)) {
		throw new Error("resolve_source_law 返回缺少 items 数组");
	}
	const items = r.items.map((it) => {
		const row = it as Record<string, unknown>;
		const laws = Array.isArray(row.source_laws) ? row.source_laws : [];
		return {
			chunkId: String(row.chunk_id ?? ""),
			sourceLaws: laws.map((l) => {
				const law = l as Record<string, unknown>;
				return {
					docNo: typeof law.doc_no === "string" ? law.doc_no : null,
					docTitle: typeof law.doc_title === "string" ? law.doc_title : null,
					clausePath: typeof law.clause_path === "string" ? law.clause_path : null,
					sourceCode: typeof law.source_code === "string" ? law.source_code : null,
				};
			}),
		} satisfies SourceLawResolution;
	});
	return {
		items,
		rejected: Array.isArray(r.rejected) ? (r.rejected as string[]) : [],
		unresolved: Array.isArray(r.unresolved) ? (r.unresolved as string[]) : [],
	};
}

/** `limitState.tripped` 的人可读描述。照 `fast-path-runtime.ts` 的 `describeTripped`:
 *  `maxTurns` 对本 runtime 这种"模型调用次数结构上可算"的管线其实意义不大(阶段 5 的批数
 *  由 `batchPairs` 定死,不会失控增长),但仍然接上这条路而不是特判掉它 —— 因为 `runTimeoutMs`
 *  确实有意义(`documents.process()`/`callTool()` 挂住时唯一能兜底的就是它),两者共用同一套
 *  `LimitState`/`limits` 插件基础设施,拆开反而多一份要维护的分支。 */
function describeTripped(kind: LimitKind, limits: RuntimeLimits): string {
	if (kind === "runTimeout") return `run 整体超时(runTimeoutMs=${limits.runTimeoutMs}ms)`;
	if (kind === "maxTurns") return `模型调用次数撞到上限(maxTurns=${limits.maxTurns})`;
	if (kind === "maxCostUsd") return `撞到费用上限(maxCostUsd=${limits.maxCostUsd})`;
	if (kind === "maxTotalTokens") return `撞到 token 上限(maxTotalTokens=${limits.maxTotalTokens})`;
	return `撞到限额:${kind}`;
}

/** 比 Runtime 多一个测试缝:装配后模型实际看得见的工具名。生产代码不读它 ——
 *  它把「模型看不到工具」这条不变量单独变成可断言的(照 fast-path 的同名探针)。 */
export interface PolicyCompareRuntime extends Runtime {
	/** 测试缝:装配后模型实际看得见的工具名。生产代码不读它。 */
	activeToolNamesForTest(): string[];
}

export async function createPolicyCompareRuntime(options: PolicyCompareRuntimeOptions): Promise<PolicyCompareRuntime> {
	if (options.outputContractSchema === undefined) {
		throw new Error(
			`RuntimeSpec "${options.spec.id}": createPolicyCompareRuntime 需要 outputContractSchema ` +
				"(阶段 6 每次都用它判;缺了会让每个 run 静默落 error)",
		);
	}
	const payload = parseCoveragePayload(options.payload);
	// ⚠ 下界必须校验,不能只 Math.min:`batchPairs` 的 `for (...; i += batchSize)` 在
	// batchSize <= 0 时**死循环**(Task 4 评审的携带项)。Java 传 `options.batchSize: 0`
	// 就能把 run 挂死,所以这里响亮拒绝而不是悄悄钳成默认值。
	const rawBatchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	if (!Number.isInteger(rawBatchSize) || rawBatchSize < 1 || rawBatchSize > MAX_BATCH_SIZE) {
		throw new Error(`options.batchSize 必须是 1..${MAX_BATCH_SIZE} 的整数(收到:${String(rawBatchSize)})`);
	}
	const batchSize = rawBatchSize;

	let currentRunId = "";
	let seq = 0;
	let aborted = false;
	const listeners = new Set<(event: RuntimeEvent) => void>();

	function emit(type: string, payloadOut: unknown): void {
		const enveloped: RuntimeEvent = {
			runId: currentRunId,
			specId: options.spec.id,
			seq: seq++,
			ts: Date.now(),
			type,
			payload: payloadOut,
		};
		for (const listener of listeners) {
			try {
				listener(enveloped);
			} catch (error) {
				console.error(`[PolicyCompareRuntime] event subscriber threw for "${type}"; continuing fan-out`, error);
			}
		}
	}

	function stage(name: Stage, percent: number, current: number, total: number, message: string): void {
		emit("compare_stage", { stage: name, percent, current, total, message });
	}

	const limitState: LimitState = { turns: 0 };

	/**
	 * 每个阶段边界都调它,合并检查两件独立的事(评审 Finding 1):
	 * - `limitState.tripped`:由无条件挂载的 limits 插件在 `turn_end` 钩子里写(`maxTurns`/
	 *   `maxTotalTokens`/`maxCostUsd`),或由下面 `run()` 里的 `runTimeoutMs` 定时器写。此前这里
	 *   只查 `aborted`,`tripped` 被写了也没人读 —— 插件确实调了 `ctx.abort()`(即
	 *   `abortFn()`,会打断当前 `session.prompt()`),但下一次阶段边界检查查的是本地 `aborted`
	 *   标志,从未被置位,于是管线在撞限之后照样继续跑完整个 run。
	 * - `aborted`:用户经公开 `abort()` 主动要求停。
	 *
	 * 顺序是 `tripped` 先查:两者理论上可能同一时刻都为真(比如 `maxTurns` 刚撞上、用户也调了
	 * `abort()`),`limit_exceeded` 携带的诊断信息(具体撞到哪一项)比笼统的"被中断"更有价值,
	 * 优先归类成前者。
	 */
	function checkPreempted(): void {
		if (limitState.tripped) throw new Error("__limit_exceeded__");
		if (aborted) throw new Error("__aborted__");
	}

	// per-run 状态,与 aborted/seq 同一条纪律:run() 开头重置(见下面 run() 方法)。放在这层
	// (而不是 runInner() 内部局部变量)是因为 run() 的 catch 分支也要读它 —— 中断/抛错若发生
	// 在阶段 5 已经真正跑过几批模型调用之后,`turns` 必须如实带出「真的发生过几次」,不能因为
	// runInner() 半途抛出就把这批已经发生的调用悄悄归零。
	let modelCalls = 0;
	let assembled!: Assembled;
	let abortFn: () => void = () => {};

	const pluginContext: Omit<PluginContext, "callTool"> = {
		getRunId: () => currentRunId,
		getSession: () => {
			if (!assembled) {
				throw new Error(
					`PolicyCompareRuntime "${options.spec.id}": PluginContext.getSession() 在装配期被调用,` +
						"AgentSession 还不存在;插件工厂必须把 session 访问推迟到 hook 回调里",
				);
			}
			return assembled.session;
		},
		abort: () => abortFn(),
		limitState,
		// 判官会 reprompt,破坏「模型调用次数可算」这条不变量(规格 §4、A8)
		registerFinalJudge: () => {
			throw new Error("PolicyCompareRuntime 不支持 final judge(判官会 reprompt,破坏固定调用次数)");
		},
		getRunInput: () => "",
	};

	assembled = await assemble({
		spec: options.spec,
		profile: options.profile,
		registry: options.registry,
		toolsets: options.toolsets,
		cwd: options.cwd,
		agentDir: options.agentDir,
		skillPaths: options.skillPaths,
		modelOverride: options.modelOverride,
		pluginContext,
		emitPluginToolEvent: (event: PluginToolCallEvent) => emit(event.type, event),
	});

	abortFn = () => {
		void assembled.session.abort().catch((error: unknown) => {
			console.error(`[PolicyCompareRuntime] abort() 失败,spec "${options.spec.id}"`, error);
		});
	};

	// 🔴 模型看不到任何工具。工具调用全部由下面的代码经 assembled.callTool 发起。
	// 不能靠 spec 里写 tools: [] —— validate.ts 明确拒绝空白名单。
	assembled.session.setActiveToolsByName([]);

	const session = assembled.session;
	const id = randomUUID();
	let lastActiveAt = Date.now();
	let running: Promise<RunResult> | undefined;

	/** 每次组装 `RunResult.usage` 都读一次实时会话统计(评审 Finding 4)——此前四处返回全部
	 *  硬编码 `{input:0,...}`,一个真打了 ~63 次模型调用的 run 在账面上显示成免费。照
	 *  `fast-path-runtime.ts` 的 `normalize()`:从 `session.getSessionStats()` 取,不自己另外
	 *  维护一份累加器 —— pi 的 session 本来就在跟踪这份状态,重复记账只会两边漂移。 */
	function currentUsage(): RunResult["usage"] {
		const stats = session.getSessionStats();
		return {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			total: stats.tokens.total,
			cost: stats.cost,
		};
	}

	/** 失败/中断路径此前止步于最后一次 `stage(...)`(比如卡在 `("assembling", 95, 0, 1)`),
	 *  进度消费方（Task 11 的 progress 端点)看到的是一个冻结在某个百分比、永远不再更新的 run
	 *  ——不知道它已经终止(评审 Minor)。这里补一条终态事件,percent 恒 100(与成功路径的终态
	 *  同一个值,保持 A9"percent 单调不减、终态 current==total"这条不变量成立),message 说明
	 *  原因;真正的成败判定仍然只看 `RunResult.status`,`compare_stage` 只负责"进度已经不再
	 *  推进"这一件事。 */
	function emitTerminalStage(message: string): void {
		emit("compare_stage", { stage: "assembling", percent: 100, current: 1, total: 1, message });
	}

	async function runInner(runId: string): Promise<RunResult> {
		const startedAt = Date.now();

		// ── 阶段 1:解析基准外规 ──────────────────────────────
		stage("extracting", 5, 0, 1, "正在解析基准外规");
		checkPreempted();
		const processed = await options.documents.process({
			objectKey: payload.external.objectKey,
			uploadId: payload.external.uploadId,
			filename: payload.external.filename,
			corpusHint: "external",
		});
		if (processed.chunkCount > MAX_EXTERNAL_CHUNKS) {
			throw new Error(`上传外规切块数 ${processed.chunkCount} 超过上限 ${MAX_EXTERNAL_CHUNKS}`);
		}
		const doc = await options.artifacts.fetch(processed.artifactKey);
		stage("extracting", 20, 1, 1, `已抽取外规条款 ${doc.clauses.length} 条`);

		// ── 阶段 2:圈定内规义务条款 ──────────────────────────
		checkPreempted();
		const obligationsRaw = await assembled.callTool("list_internal_obligations", {
			organizations: [],
			biz_domains: payload.scope.bizDomains ?? [],
			chapters: payload.scope.chapters ?? [],
			effective_from: payload.scope.effectiveDateRange?.[0],
			effective_to: payload.scope.effectiveDateRange?.[1],
			limit: MAX_OBLIGATIONS,
		});
		const obligations = toObligations(obligationsRaw);
		// `limit: MAX_OBLIGATIONS` 只是请求里的一个字段,M1 有没有真的遵守它是另一回事(评审
		// Minor)——`MAX_EXTERNAL_CHUNKS`/`MAX_BATCH_SIZE` 两条护栏都是本地强制的,这条不能只
		// 停在"传了参数"就算数。M1 若回了 600 条,阶段 5 会扇出 ~75 次模型调用,`batchSize` 上限
		// 20 也管不住总条数。
		if (obligations.items.length > MAX_OBLIGATIONS) {
			throw new Error(
				`list_internal_obligations 返回 ${obligations.items.length} 条,超过上限 ${MAX_OBLIGATIONS}` +
					"(已传 limit 参数但返回条数仍超限,M1 未遵守)",
			);
		}
		stage(
			"extracting",
			35,
			obligations.items.length,
			obligations.total,
			`已圈定内规义务条款 ${obligations.items.length} 条`,
		);

		// ── 阶段 3:映射反查 ─────────────────────────────────
		checkPreempted();
		stage("matching", 45, 0, obligations.items.length, "正在反查外规映射");
		const resolutionsRaw = await assembled.callTool("resolve_source_law", {
			chunk_ids: obligations.items.map((o) => o.chunkId),
		});
		const resolutions = toResolutions(resolutionsRaw);

		// ── 阶段 4:正文对齐(纯代码)────────────────────────
		checkPreempted();
		const alignment = alignClauses(doc, obligations.items, resolutions.items);
		stage("matching", 55, alignment.pairs.length, obligations.items.length, "正在匹配内部制度条款");

		// ── 阶段 5:模型判定 ─────────────────────────────────
		const batches = batchPairs(alignment.pairs, batchSize);
		const verdicts: Verdict[] = [];
		for (const [i, batch] of batches.entries()) {
			checkPreempted();
			const baseIndex = batches.slice(0, i).reduce((n, b) => n + b.length, 0);
			modelCalls += 1;
			await session.prompt(renderBatchPrompt(batch, baseIndex));
			lastActiveAt = Date.now();
			verdicts.push(...parseVerdicts(session.getLastAssistantText() ?? ""));
			stage("judging", 55 + Math.round((35 * (i + 1)) / batches.length), i + 1, batches.length, "正在生成差异判断");
		}

		// ── 阶段 6:组装 ────────────────────────────────────
		checkPreempted();
		stage("assembling", 95, 0, 1, "正在组装结果");
		const extraGaps = [
			...resolutions.rejected.map((cid) => `resolve_source_law 拒绝了本 run 结果集外的 chunk_id:${cid}`),
			...resolutions.unresolved.map((cid) => `内规条款 ${cid} 在源库中没有外规映射`),
		];
		const result = buildCoverageResult({
			alignment,
			verdicts,
			// ⚠ `items.length` 不是 `total`:守恒按**实际处理**的条数算。`total` 是库内真实
			// 条数,被 limit 截断时更大,只用于 truncated 的 gaps 文案。
			checkedCount: obligations.items.length,
			libraryTotal: obligations.total,
			truncated: obligations.truncated,
			externalDocNo: doc.docNo ?? null,
			extraGaps,
		});
		const checked = validateCoverageResult(
			result,
			{
				internalChunkIds: new Set(obligations.items.map((o) => o.chunkId)),
				externalTexts: new Set(doc.clauses.map((c) => c.text)),
				internalTexts: new Set(obligations.items.map((o) => o.text)),
				// 与上面 buildCoverageResult 同一个口径:实际处理数,不是库内总数
				checkedCount: obligations.items.length,
			},
			options.outputContractSchema,
		);
		if (!checked.ok) {
			const errorMessage = `输出契约校验失败: ${checked.detail}`;
			emitTerminalStage(errorMessage);
			return {
				runId,
				specId: options.spec.id,
				status: "error",
				errorMessage,
				usage: currentUsage(),
				turns: modelCalls,
				durationMs: Date.now() - startedAt,
				judgeAttempts: {},
			};
		}
		stage("assembling", 100, 1, 1, "比对完成");

		return {
			runId,
			specId: options.spec.id,
			status: "completed",
			output: "```json\n" + JSON.stringify(result) + "\n```",
			usage: currentUsage(),
			turns: modelCalls,
			durationMs: Date.now() - startedAt,
			judgeAttempts: {},
		};
	}

	return {
		id,
		specId: options.spec.id,
		// 字段名照 session-runtime.ts —— pi 的 AgentSession 暴露的是 `sessionId`,不是 `id`
		sessionId: session.sessionId,

		async run(_input: string, opts?: RunOptions): Promise<RunResult> {
			// 重入保护(评审 Minor):`currentRunId`/`seq`/`aborted`/`modelCalls`/`running` 全是
			// 单槽状态,两个重叠的 run() 会互相踩——先结束的那个的 finally 会把还在飞的那个的
			// `running` 清掉,`isIdle`/`waitForIdle()` 因此在后者还没真正跑完时就撒谎说"闲了"。
			// `RunManager` 今天是一个 run 配一个 runtime 实例,所以这个坑目前是潜伏的,但接口本身
			// 不该允许调用方犯这个错——响亮拒绝,不是留给运气。
			if (running) {
				throw new Error(
					`PolicyCompareRuntime "${options.spec.id}": run() 被并发调用,上一个 run 还没结束。` +
						"本 runtime 的 currentRunId/seq/aborted/modelCalls 是单槽 per-run 状态,不支持重入" +
						"——调用方必须等 waitForIdle() 或上一次 run() 的返回值 resolve 之后再发起下一次。",
				);
			}
			currentRunId = opts?.runId ?? randomUUID();
			aborted = false;
			seq = 0;
			limitState.turns = 0;
			// `tripped` 与 `turns` 同一条纪律:不重置的话,同一个 runtime 实例上第二次 run() 会
			// 继承上一次已经 tripped 的 limitState,一开始就被 checkPreempted() 判掉(评审
			// Finding 1;与 fast-path-runtime.ts 的 runFast() 开头重置同一处理)。
			limitState.tripped = undefined;
			modelCalls = 0;
			const startedAt = Date.now();

			// 挂钟硬顶(评审 Finding 1)。limits 插件只在 `turn_end`(即每次 `session.prompt()`
			// 完成一轮之后)才有机会检查,看不见"某一次 `documents.process()`/`callTool()` 调用
			// 本身就挂住了"这种轮内卡死——runTimeoutMs 因此必须由这里另开一个独立定时器兜底,
			// 与 limits 插件共写同一个 `limitState.tripped`(单一事实来源)。照
			// fast-path-runtime.ts 的同名定时器。
			const limits = options.spec.limits;
			let timer: NodeJS.Timeout | undefined;
			if (limits.runTimeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (limitState.tripped) return; // limits 插件已经先一步 trip,不重复覆盖
					limitState.tripped = "runTimeout";
					abortFn();
				}, limits.runTimeoutMs);
			}

			running = (async () => {
				try {
					return await runInner(currentRunId);
				} catch (error) {
					// `limitState.tripped` 优先于具体抛错内容判断(评审 Finding 1 的第二层):
					// `abortFn()` 打断一次正在飞的 `session.prompt()` 之后,pi 可能让它直接
					// reject(这里会走到),也可能只是提前返回一段被截断的文本、不抛(那种情况
					// 由 `checkPreempted()` 在下一个阶段边界抓,见该函数文档)——先查 `tripped`
					// 能同时接住这两条路径,不用去猜某次具体抛错是不是"因为超时/撞限而被打断"。
					const tripped = limitState.tripped;
					if (tripped) {
						const reason = describeTripped(tripped, limits);
						emitTerminalStage(reason);
						return {
							runId: currentRunId,
							specId: options.spec.id,
							status: "limit_exceeded",
							errorMessage: reason,
							limit: tripped,
							usage: currentUsage(),
							turns: modelCalls,
							durationMs: Date.now() - startedAt,
							judgeAttempts: {},
						};
					}
					const message = error instanceof Error ? error.message : String(error);
					const status = message === "__aborted__" ? ("aborted" as const) : ("error" as const);
					const errorMessage = message === "__aborted__" ? "run 被中断" : message;
					emitTerminalStage(errorMessage);
					return {
						runId: currentRunId,
						specId: options.spec.id,
						status,
						errorMessage,
						usage: currentUsage(),
						// 中断/抛错可能发生在阶段 5 已经真正跑过几批模型调用之后 —— 如实带出
						// modelCalls,不是硬编码 0(否则一次发生在第 2 批 prompt 期间的 abort,
						// 会让已经真实发生过的第 1 批调用凭空消失在 turns 里)。
						turns: modelCalls,
						durationMs: Date.now() - startedAt,
						judgeAttempts: {},
					};
				} finally {
					if (timer) clearTimeout(timer);
				}
			})();
			try {
				return await running;
			} finally {
				running = undefined;
			}
		},

		// 工作流没有「插话」语义:两者都会让确定性管线跑到一个未定义的状态
		async steer(): Promise<void> {
			throw new Error("PolicyCompareRuntime 不支持 steer(确定性工作流无插话语义)");
		},
		async followUp(): Promise<void> {
			throw new Error("PolicyCompareRuntime 不支持 followUp(确定性工作流无插话语义)");
		},

		async abort(): Promise<void> {
			aborted = true;
			abortFn();
		},

		async waitForIdle(): Promise<void> {
			if (running) await running.catch(() => undefined);
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		get isIdle() {
			return running === undefined;
		},
		get lastActiveAt() {
			return lastActiveAt;
		},
		snapshot() {
			return { sessionId: session.sessionId, sessionFile: session.sessionFile ?? undefined };
		},
		async dispose() {
			// 评审 Minor:此前不清 `listeners`,订阅者在 dispose() 之后仍然"可达"(`Set` 还握着
			// 它们的引用,虽然 dispose 之后已经没有任何东西会再 emit,但与 session-runtime.ts /
			// fast-path-runtime.ts 的 dispose() 同一条纪律,统一清空)。
			listeners.clear();
			await assembled.dispose();
		},
		activeToolNamesForTest() {
			return session.getActiveToolNames();
		},
	};
}
