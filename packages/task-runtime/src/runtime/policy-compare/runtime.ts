import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
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
/**
 * 阶段 4 产出的待判定条款对上限(规格 §3.5)。
 *
 * 🔴 决定阶段 5 扇出的是 `pairs.length`,**不是**义务条款数:`align.ts` 的 `doc_level` 分支
 * (M2 映射粒度为文档级时的降级形态,规格 §5.2)让**一条**内规与上传件的**全部**条款成对,
 * 上界因此是 `MAX_OBLIGATIONS × MAX_EXTERNAL_CHUNKS`,不是 `MAX_OBLIGATIONS`。没有这道护栏时,
 * 50 条内规 × 100 条外规条款 = 5000 对 → 625 批,先撞 `maxCostUsd` 或 `maxTurns`,两者都是
 * fail-closed 丢弃整个 output —— 烧完预算、零产出。
 *
 * 定值 500:非 `doc_level` 路径下一条内规最多产 1 对,所以 500 恰好放行 `MAX_OBLIGATIONS`
 * 的全量;同时 `ceil(500 / batchSize 下界 1) = 500 < maxTurns=600`,spec 那条不等式仍成立。
 */
export const MAX_PAIRS = 500;

const ALL_OUTPUT_TYPES = ["summary_diff", "missing_items", "partial_items", "conflict_items"];

/**
 * 范围收窄参数的形状校验。**形状不对即抛**,不静默降级成 `undefined`。
 *
 * 静默忽略一个范围收窄参数 = 越权返回:M1 收到空数组按「不限」处理,比对范围会从
 * 「费用报销这一个域」悄悄放大到全部内规,而调用方看到的是一次正常完成的 run。
 * Java 侧把单值写成 `bizDomains: "费用报销"`(没包数组)是常见的上游 bug,元素类型
 * 也一并校验 —— `[123]` 原样下传只会在 M1 的 SQL 里变成一次匹配不上的静默收窄。
 */
function parseScopeStringArray(value: unknown, path: string): string[] | undefined {
	// null 与缺席同义:JSON 侧「这一项没设」的惯用写法,按「不限」处理
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
		throw new Error(`${path} 必须是非空字符串数组(收到:${JSON.stringify(value)})—— 范围收窄参数不接受静默降级`);
	}
	return value as string[];
}

function parseScopeDateRange(value: unknown, path: string): [string, string] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "string" || v === "")) {
		throw new Error(
			`${path} 必须是 [开始日期, 结束日期] 两个非空字符串(收到:${JSON.stringify(value)})—— 范围收窄参数不接受静默降级`,
		);
	}
	return [value[0] as string, value[1] as string];
}

/**
 * `POST /runs` 的 `payload` 形状校验。**装配期就跑**,不拖到阶段 5(规格 §7.1)。
 *
 * 两个字段本轮不生效但必须显式拒绝(规格 §3.1):
 * - `scope.organizations` —— PG 无对应列,静默忽略一个范围收窄参数等于越权返回
 * - `outputTypes` —— 协议 §3.4 规定它恒为全选;收到别的值说明上游理解有偏差,要炸出来
 *
 * 其余三个收窄参数(`bizDomains` / `chapters` / `effectiveDateRange`)同姿态:形状不对即抛,
 * 见 `parseScopeStringArray`。
 */
export function parseCoveragePayload(raw: unknown): CoveragePayload {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("payload 必须是 JSON 对象");
	}
	const p = raw as Record<string, unknown>;
	const direction = p.direction === undefined ? "external_to_internal" : p.direction;
	if (direction !== "external_to_internal" && direction !== "internal_to_external") {
		throw new Error("payload.direction 仅支持 external_to_internal 或 internal_to_external");
	}
	const subjectKey = direction === "external_to_internal" ? "external" : "internal";
	const external = p[subjectKey] as Record<string, unknown> | undefined;
	const source =
		external?.source ??
		(external && (external.objectKey || external.uploadId || external.filename) ? "upload" : undefined);
	if (source !== "upload" && source !== "library")
		throw new Error(`payload.${subjectKey}.source 仅支持 upload 或 library`);
	if (source === "upload") {
		for (const key of ["objectKey", "uploadId", "filename"]) {
			if (!external || typeof external[key] !== "string" || external[key] === "") {
				throw new Error(`payload.${subjectKey}.${key} 必填且必须是非空字符串`);
			}
		}
	} else if (!external || typeof external.docVersionId !== "string" || external.docVersionId === "") {
		throw new Error(`payload.${subjectKey}.docVersionId 必填且必须是非空字符串`);
	}
	const scope = (p.scope ?? {}) as Record<string, unknown>;
	// `organizations` 本轮压根没实现(PG 无对应列)—— 这个判断跟值的形状对不对无关,所以要在
	// 形状校验**之前**做。此前借道 `parseScopeStringArray` 校验形状:非数组值(如
	// `organizations: "东方证券"`,没包数组的常见上游 bug)会先撞上那条「必须是非空字符串数组」的
	// 消息,暗示「改成数组就能过」;调用方改成 `["东方证券"]` 重试后才真正撞见「未实现」——两轮
	// 报错才诊断得清。这里直接判「有没有传东西」,不管形状对不对,一次说清。
	const rawOrganizations = scope.organizations;
	const organizationsGiven =
		rawOrganizations !== undefined &&
		rawOrganizations !== null &&
		!(Array.isArray(rawOrganizations) && rawOrganizations.length === 0);
	if (organizationsGiven) {
		throw new Error(
			`payload.scope.organizations 非空 —— 「适用组织」维度本轮无可用数据列,未实现(不静默忽略,` +
				`不论传的是什么形状都一样拒;收到:${JSON.stringify(rawOrganizations)})`,
		);
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
		direction,
		...(direction === "external_to_internal"
			? {
					external:
						source === "upload"
							? {
									source: "upload" as const,
									objectKey: external!.objectKey as string,
									uploadId: external!.uploadId as string,
									filename: external!.filename as string,
								}
							: { source: "library" as const, docVersionId: external!.docVersionId as string },
				}
			: {
					internal:
						source === "upload"
							? {
									source: "upload" as const,
									objectKey: external!.objectKey as string,
									uploadId: external!.uploadId as string,
									filename: external!.filename as string,
								}
							: { source: "library" as const, docVersionId: external!.docVersionId as string },
				}),
		scope: {
			organizations: [],
			bizDomains: parseScopeStringArray(scope.bizDomains, "payload.scope.bizDomains"),
			chapters: parseScopeStringArray(scope.chapters, "payload.scope.chapters"),
			effectiveDateRange: parseScopeDateRange(scope.effectiveDateRange, "payload.scope.effectiveDateRange"),
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
	permissionTags?: string[];
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
	// 🔴 chunk_id 必须唯一,否则守恒会以一条**指错病因**的信息判负:`checkedCount` 取
	// `items.length`(按行数),而 `buildCoverageResult` 的 metrics 按 `chunkId` 分组累加
	// (按去重后的条数),两者只在唯一时相等。规格 §5.1 的 M1 SQL 是
	// `chunks JOIN clause_tags ... AND deontic_type IN (:deontic_types)` —— 同一 chunk 挂了多条
	// `is_obligation` 标签(不同 `deontic_type`)就会出重复行,E1 富集里并非不可能。
	// 届时 `validate-result.ts` 会报「metrics 不自洽」,而那条信息的文档写着「判负 = 代码 bug」,
	// 值班的人会去查 TS 组装代码,病因却在 M1 的 JOIN。
	// **抛错而不是去重**:去重会把 `checkedCount` 的语义从「M1 返回了几条」悄悄改成
	// 「去重后几条」,是另一个更难发现的口径漂移。
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const it of items) {
		if (seen.has(it.chunkId)) duplicated.add(it.chunkId);
		seen.add(it.chunkId);
	}
	if (duplicated.size > 0) {
		throw new Error(
			`list_internal_obligations 返回了重复 chunk_id(${[...duplicated].join("、")})—— ` +
				"同一 chunk 挂多条 is_obligation 标签会让 M1 的 JOIN 出重复行;请在 M1 侧按 chunk_id 去重后再返回",
		);
	}
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
 *  确实有意义(它是"整个 run 跑太久"的唯一兜底;单次外部调用挂死另有各自的超时,见 run() 里
 *  那条定时器的说明),两者共用同一套 `LimitState`/`limits` 插件基础设施,拆开反而多一份要
 *  维护的分支。 */
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
		if (payload.direction === "internal_to_external") {
			const internal = payload.internal!;
			stage("extracting", 5, 0, 1, "正在解析待核查内规");
			checkPreempted();
			const processed =
				internal.source === "upload"
					? await options.documents.process({
							objectKey: internal.objectKey,
							uploadId: internal.uploadId,
							filename: internal.filename,
							corpusHint: "internal",
						})
					: null;
			const doc = processed ? await options.artifacts.fetch(processed.artifactKey) : null;
			stage("extracting", 35, doc?.clauses.length ?? 1, doc?.clauses.length ?? 1, "已取得内规条款与显式外规引用");
			checkPreempted();
			stage("matching", 55, 0, 1, "正在核对引用外规的当前版本");
			if (!options.documents.checkInternalReferenceVersions) {
				throw new Error("内规引用外规版本核查客户端未配置");
			}
			const result = await options.documents.checkInternalReferenceVersions({
				docVersionId: internal.source === "library" ? internal.docVersionId : undefined,
				clauses: doc?.clauses.map((clause) => ({
					chunkId: `upload:${internal.source === "upload" ? internal.uploadId : "library"}:${clause.seq}`,
					clausePath: clause.clausePath || null,
					text: clause.text,
				})),
				effectiveDateRange: payload.scope.effectiveDateRange,
				permTags: options.permissionTags ?? [],
			});
			stage("assembling", 95, 0, 1, "正在组装外规版本变更结果");
			if (!Value.Check(options.outputContractSchema as never, result as never)) {
				const first = [...Value.Errors(options.outputContractSchema as never, result as never)][0];
				const errorMessage = `输出契约校验失败: ${first ? `${first.instancePath}: ${first.message}` : "schema 校验失败"}`;
				emitTerminalStage(errorMessage);
				return {
					runId,
					specId: options.spec.id,
					status: "error",
					errorMessage,
					usage: currentUsage(),
					turns: 0,
					durationMs: Date.now() - startedAt,
					judgeAttempts: {},
				};
			}
			stage("assembling", 100, 1, 1, "比对完成");
			return {
				runId,
				specId: options.spec.id,
				status: "completed",
				output: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
				usage: currentUsage(),
				turns: 0,
				durationMs: Date.now() - startedAt,
				judgeAttempts: {},
			};
		}

		// ── 阶段 1:解析基准外规 ──────────────────────────────
		stage("extracting", 5, 0, 1, "正在解析基准外规");
		checkPreempted();
		const processed =
			payload.external!.source === "upload"
				? await options.documents.process({
						objectKey: payload.external!.objectKey,
						uploadId: payload.external!.uploadId,
						filename: payload.external!.filename,
						corpusHint: "external",
					})
				: null;
		// 这一道只信 E0 自报的 `chunk_count`,作用是在下载整份 artifact **之前**就挡住明显超规模的
		// 产物;它拦不住「E0 少回了这个字段」——`documents-client.ts` 对非数字落 `0`,恒不触发。
		if (processed && processed.chunkCount > MAX_EXTERNAL_CHUNKS) {
			throw new Error(`上传外规切块数 ${processed.chunkCount} 超过上限 ${MAX_EXTERNAL_CHUNKS}(E0 自报 chunk_count)`);
		}
		const doc =
			payload.external!.source === "upload"
				? await options.artifacts.fetch(processed!.artifactKey)
				: options.documents.getExternalDocument
					? await options.documents.getExternalDocument(
							payload.external!.docVersionId,
							options.permissionTags ?? [],
						)
					: (() => {
							throw new Error("知识库外规读取客户端未配置");
						})();
		// 🔴 本地复核,与阶段 2 对 M1 的 `items.length > MAX_OBLIGATIONS` 是同一姿态:上游自报的数字
		// 只是提示,真正决定阶段 5 扇出规模的是**这里实际拿到的条款数**。少了这一道,E0 漏回
		// `chunk_count` 时一份 5000 条款的产物会长驱直入。
		// 注意两个数不同义:`chunk_count` 是全部切块,这里是过滤掉表格/目录之后的条款块 ——
		// 后者才是与 `MAX_EXTERNAL_CHUNKS` 同量纲的那个量(它给阶段 4/5 定扇出上界)。
		if (doc.clauses.length > MAX_EXTERNAL_CHUNKS) {
			throw new Error(
				`上传外规解析出 ${doc.clauses.length} 条条款,超过上限 ${MAX_EXTERNAL_CHUNKS}` +
					`(E0 自报 chunk_count=${processed?.chunkCount ?? doc.clauses.length},以实际解析条数为准)`,
			);
		}
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
			// M2 先用权威 R4 映射；本地/早期数据尚无映射时，这个显式目标允许它返回
			// doc_level 候选。候选仍须经过阶段 5 的逐条模型判定，不能直接算“已覆盖”。
			target_document: { title: doc.title, doc_no: doc.docNo ?? null },
		});
		const resolutions = toResolutions(resolutionsRaw);

		// ── 阶段 4:正文对齐(纯代码)────────────────────────
		checkPreempted();
		const alignment = alignClauses(doc, obligations.items, resolutions.items);
		// 🔴 扇出护栏(规格 §3.5)。批数是 `ceil(pairs.length / batchSize)`,而 `doc_level` 降级下
		// pairs 是「内规条款数 × 上传件条款数」的乘积 —— 阶段 2 的 500 条上限完全管不住它。
		// 超限就在这里响亮停下:继续跑只会撞 maxTurns/maxCostUsd,那两条都是 fail-closed 丢弃整个
		// output,钱花完、一行结果也拿不到。
		if (alignment.pairs.length > MAX_PAIRS) {
			const docLevel = alignment.pairs.filter((p) => p.matchKind === "doc_level").length;
			throw new Error(
				`阶段 4 产出 ${alignment.pairs.length} 对待判定条款,超过上限 ${MAX_PAIRS}` +
					`(内规义务 ${obligations.items.length} 条 × 上传外规 ${doc.clauses.length} 条条款;` +
					`其中 doc_level 扇出 ${docLevel} 对 —— M2 映射粒度为文档级时一条内规与整篇外规全部条款成对,` +
					"见规格 §5.2 的降级说明。请收窄 scope 或等条款级映射到位)",
			);
		}
		stage("matching", 55, alignment.pairs.length, obligations.items.length, "正在匹配内部制度条款");

		// ── 阶段 5:模型判定 ─────────────────────────────────
		const batches = batchPairs(alignment.pairs, batchSize);
		const verdicts: Verdict[] = [];
		/** 越界判定的明细。**不静默丢** —— 阶段 6 一并写进 gaps。 */
		const discardedVerdicts: string[] = [];
		for (const [i, batch] of batches.entries()) {
			checkPreempted();
			const baseIndex = batches.slice(0, i).reduce((n, b) => n + b.length, 0);
			modelCalls += 1;
			await session.prompt(renderBatchPrompt(batch, baseIndex));
			lastActiveAt = Date.now();
			// 🔴 只采纳落在**本批** pairIndex 区间内的判定。模型若按批内序号从 0 重新编号,它回的
			// 下标会落到前面批次那几对上,而阶段 6 是「后写覆盖先写」—— 判定会静默挂到错误的条款对
			// 上,两侧正文却仍是各自的原文,schema 与四条反幻觉全都照过。
			const parsed = parseVerdicts(session.getLastAssistantText() ?? "", {
				start: baseIndex,
				endExclusive: baseIndex + batch.length,
			});
			verdicts.push(...parsed.verdicts);
			for (const received of parsed.outOfRange) {
				discardedVerdicts.push(
					`模型回了本批之外的 pairIndex,已丢弃:收到 ${received},` +
						`本批合法区间 [${baseIndex}, ${baseIndex + batch.length})`,
				);
			}
			stage("judging", 55 + Math.round((35 * (i + 1)) / batches.length), i + 1, batches.length, "正在生成差异判断");
		}

		// ── 阶段 6:组装 ────────────────────────────────────
		checkPreempted();
		stage("assembling", 95, 0, 1, "正在组装结果");
		const extraGaps = [
			...resolutions.rejected.map((cid) => `resolve_source_law 拒绝了本 run 结果集外的 chunk_id:${cid}`),
			...resolutions.unresolved.map((cid) => `内规条款 ${cid} 在源库中没有外规映射`),
			...discardedVerdicts,
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
			output: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
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
			// 完成一轮之后)才有机会检查,看不见"整个 run 已经跑了太久"这件事——runTimeoutMs 因此
			// 由这里另开一个独立定时器兜底,与 limits 插件共写同一个 `limitState.tripped`(单一事实
			// 来源)。照 fast-path-runtime.ts 的同名定时器。
			//
			// ⚠ 这条定时器**能**做什么、**不能**做什么,如实写清楚(终审 I5):触发时它置
			// `tripped` 并调 `abortFn()`,而 `abortFn()` 只是 `session.abort()` —— 它打断得了在飞的
			// `session.prompt()`,打断不了阶段 1/2/3 那三个 await。那三处各自有**自己的**超时,
			// 不靠这条定时器:
			//   · `documents.process()` —— `createDocumentsClient` 的 `timeoutMs`,走 AbortController
			//   · `artifacts.fetch()`   —— `createArtifactStore` 的 `timeoutMs`(Promise.race,不取消底层读)
			//   · `callTool()`          —— MCP 客户端的 `requestTimeoutMs`(默认 30s)
			// 这条定时器 abort 不了它们,这点三条腿共通;但「少了各自那道会怎样」并不是同一句话能
			// 概括的,三条腿差得远:
			//   · `artifacts.fetch()` 背后的 MinIO `getObject` 与读流两步都没有自带超时,拿掉
			//     `timeoutMs` 这层 `Promise.race` 后是真的可能永不 settle。
			//   · `documents.process()` 背后是 undici 的 `fetch`,拿掉 `timeoutMs`/`AbortController`
			//     后还有 undici 默认的 headersTimeout/bodyTimeout(各 300s)兜底 —— 会拖得远超
			//     `runTimeoutMs`,但不是永不(见 `documents-client.ts` 的说明)。
			//   · `callTool()` 本来就有 MCP 客户端默认 30s 的 `requestTimeoutMs` 兜着 —— 这道边界
			//     内建在通用 MCP 客户端里,不是 `PolicyCompareRuntime` 这层配的,也不会因为这里
			//     漏配什么而消失。
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
