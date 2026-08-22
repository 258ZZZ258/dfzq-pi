import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type { ProviderProfile } from "../../env/provider-profile.ts";
import type { RuntimeLimits, RuntimeSpec } from "../../spec/types.ts";
import type { ToolsetRegistry } from "../../toolsets/registry.ts";
import { type Assembled, type AssembleOptions, assemble, type PluginToolCallEvent } from "../assembler.ts";
import type { LimitKind, LimitState, RunOptions, RunResult, Runtime, RuntimeEvent } from "../contract.ts";
import type { PluginContext, PluginRegistry } from "../plugin-registry.ts";
import { alignBatchCandidates } from "./align.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { buildCoverageResult } from "./assemble.ts";
import type { DocumentsClient } from "./documents-client.ts";
import { filterExternalObligationClauses } from "./obligation.ts";
import type { CoveragePayload, InternalObligation, Verdict } from "./types.ts";
import { validateCoverageResult } from "./validate-result.ts";
import { batchPairs, parseVerdicts, renderBatchPrompt } from "./verdicts.ts";

/** 规格 §3.5 的护栏定值。 */
export const MAX_BATCH_SIZE = 20;
export const DEFAULT_BATCH_SIZE = 8;
export const MAX_EXTERNAL_CHUNKS = 800;
/**
 * 阶段 4 产出的待判定条款对上限(规格 §3.5)。
 *
 * 🔴 决定阶段 5 扇出的是每条外规返回的内规候选总数。没有这道护栏时，一份大外规与大量
 * 候选内规会产生数千对待判定条款，先撞 `maxCostUsd` 或 `maxTurns`，最后零产出。
 *
 * 定值 500：同时 `ceil(500 / batchSize 下界 1) = 500 < maxTurns=600`，spec 的不等式仍成立。
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

/** 解析 audit-ai 批量检索候选。每条输入必须得到同序、唯一的结果项，避免候选错配。 */
function toBatchCandidates(
	raw: unknown,
	expectedCount: number,
	toolName = "retrieve_internal_candidates_batch",
): Array<{
	queryIndex: number;
	candidates: InternalObligation[];
	error: string | null;
}> {
	const r = raw as { items?: unknown } | null;
	if (!r || !Array.isArray(r.items) || r.items.length !== expectedCount) {
		throw new Error(`${toolName} 返回 items 数量异常(期望 ${expectedCount})`);
	}
	const seen = new Set<number>();
	return r.items.map((value) => {
		const row = value as Record<string, unknown>;
		const queryIndex = row.query_index;
		if (
			typeof queryIndex !== "number" ||
			!Number.isInteger(queryIndex) ||
			queryIndex < 0 ||
			queryIndex >= expectedCount ||
			seen.has(queryIndex)
		) {
			throw new Error(`${toolName} 返回了非法或重复 query_index`);
		}
		seen.add(queryIndex);
		if (!Array.isArray(row.candidates)) {
			throw new Error(`${toolName} 返回缺少 candidates 数组`);
		}
		const candidateIds = new Set<string>();
		const candidates = row.candidates.map((candidate) => {
			const c = candidate as Record<string, unknown>;
			const chunkId = typeof c.chunk_id === "string" ? c.chunk_id : "";
			const text = typeof c.text === "string" ? c.text : "";
			if (!chunkId || !text || candidateIds.has(chunkId)) {
				throw new Error(`${toolName} 返回候选缺少正文、chunk_id 或有重复候选`);
			}
			candidateIds.add(chunkId);
			return {
				chunkId,
				clausePath: typeof c.clause_path === "string" ? c.clause_path : null,
				docTitle: typeof c.doc_title === "string" ? c.doc_title : null,
				docNo: typeof c.doc_no === "string" ? c.doc_no : null,
				deonticType: "obligation",
				evidence: null,
				text,
				sourceCode: typeof c.source_code === "string" ? c.source_code : null,
			} satisfies InternalObligation;
		});
		return { queryIndex, candidates, error: typeof row.error === "string" ? row.error : null };
	});
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
			if (!options.documents.checkInternalReferenceVersions) {
				throw new Error("内规→外规覆盖核查客户端未配置");
			}
			const processed =
				internal.source === "upload"
					? await options.documents.process({
							objectKey: internal.objectKey,
							uploadId: internal.uploadId,
							filename: internal.filename,
							corpusHint: "internal",
						})
					: null;
			const uploadDocument =
				internal.source === "upload" ? await options.artifacts.fetch(processed!.artifactKey) : undefined;
			if (uploadDocument && uploadDocument.clauses.length > MAX_EXTERNAL_CHUNKS) {
				throw new Error(`内规解析出 ${uploadDocument.clauses.length} 条条款,超过上限 ${MAX_EXTERNAL_CHUNKS}`);
			}
			stage("extracting", 20, 0, 1, "正在核对内规已引用外规的版本与条款变动");
			checkPreempted();
			const result = await options.documents.checkInternalReferenceVersions(
				internal.source === "library"
					? {
							docVersionId: internal.docVersionId,
							effectiveDateRange: payload.scope.effectiveDateRange,
							permTags: options.permissionTags ?? [],
						}
					: {
							clauses: uploadDocument!.clauses.map((clause) => ({
								chunkId: `${internal.uploadId}:${clause.seq}`,
								clausePath: clause.clausePath,
								text: clause.text,
							})),
							effectiveDateRange: payload.scope.effectiveDateRange,
							permTags: options.permissionTags ?? [],
						},
			);
			if (!Value.Check(options.outputContractSchema as never, result as never)) {
				const first = [...Value.Errors(options.outputContractSchema as never, result as never)][0];
				throw new Error(
					`引用版本核查输出契约校验失败:${first ? `${first.instancePath}: ${first.message}` : "未知错误"}`,
				);
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
		// 🔴 本地复核:上游自报的数字只是提示,真正决定阶段 5 扇出规模的是**这里实际拿到的条款数**。少了这一道,E0 漏回
		// `chunk_count` 时一份 5000 条款的产物会长驱直入。
		// 注意两个数不同义:`chunk_count` 是全部切块,这里是过滤掉表格/目录之后的条款块 ——
		// 后者才是与 `MAX_EXTERNAL_CHUNKS` 同量纲的那个量(它给阶段 4/5 定扇出上界)。
		if (doc.clauses.length > MAX_EXTERNAL_CHUNKS) {
			throw new Error(
				`上传外规解析出 ${doc.clauses.length} 条条款,超过上限 ${MAX_EXTERNAL_CHUNKS}` +
					`(E0 自报 chunk_count=${processed?.chunkCount ?? doc.clauses.length},以实际解析条数为准)`,
			);
		}
		const coverageDoc = {
			...doc,
			clauses: filterExternalObligationClauses(doc.clauses),
		};
		stage(
			"extracting",
			20,
			coverageDoc.clauses.length,
			doc.clauses.length,
			`已抽取外规条款 ${doc.clauses.length} 条，其中规范性义务条款 ${coverageDoc.clauses.length} 条`,
		);

		// 说明性、定义性外规条款不是覆盖度核查对象；为空时绝不向 audit-ai 发起空批量语义检索。
		if (coverageDoc.clauses.length === 0) {
			stage("assembling", 95, 0, 1, "未识别到规范性义务条款，无需检索内规");
			const result = buildCoverageResult({
				alignment: { pairs: [], unmatched: [], countBy: "external" },
				verdicts: [],
				checkedCount: 0,
				truncated: false,
				externalDocNo: coverageDoc.docNo ?? null,
				extraGaps: ["未识别到含应当、必须、不得、禁止等规范性义务词的外规条款，本次未执行内规语义检索。"],
			});
			const checked = validateCoverageResult(
				result,
				{ internalChunkIds: new Set(), externalTexts: new Set(), internalTexts: new Set(), checkedCount: 0 },
				options.outputContractSchema,
			);
			if (!checked.ok) throw new Error(`输出契约校验失败: ${checked.detail}`);
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

		// ── 阶段 2:外规条款批量检索候选内规 ───────────────────
		checkPreempted();
		const candidatesRaw = await assembled.callTool("retrieve_internal_candidates_batch", {
			clauses: coverageDoc.clauses.map((clause) => ({ clause_path: clause.clausePath, text: clause.text })),
		});
		const candidateItems = toBatchCandidates(candidatesRaw, coverageDoc.clauses.length);
		const candidateCount = candidateItems.reduce((sum, item) => sum + item.candidates.length, 0);
		stage(
			"extracting",
			35,
			candidateItems.length,
			coverageDoc.clauses.length,
			`已为 ${coverageDoc.clauses.length} 条外规检索到 ${candidateCount} 条内规候选`,
		);

		// ── 阶段 3:按外规条款建立候选配对 ─────────────────────
		checkPreempted();
		stage("matching", 45, 0, coverageDoc.clauses.length, "正在匹配候选内部制度条款");
		const alignment = alignBatchCandidates(coverageDoc, candidateItems);
		// 🔴 扇出护栏(规格 §3.5)。候选总对数决定模型批数；超限就在这里停下，避免烧完预算后零产出。
		if (alignment.pairs.length > MAX_PAIRS) {
			throw new Error(
				`阶段 4 产出 ${alignment.pairs.length} 对待判定条款,超过上限 ${MAX_PAIRS}` +
					"(请收窄上传外规范围或降低 audit-ai 的候选条数)",
			);
		}
		stage("matching", 55, alignment.pairs.length, coverageDoc.clauses.length, "正在匹配内部制度条款");

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
		const extraGaps = [...discardedVerdicts];
		const result = buildCoverageResult({
			alignment,
			verdicts,
			// 批量检索路径按外规条款计数；每条外规最终都必须落为 covered/missing/conflict/unmatched 之一。
			checkedCount: coverageDoc.clauses.length,
			truncated: false,
			externalDocNo: coverageDoc.docNo ?? null,
			extraGaps,
		});
		const checked = validateCoverageResult(
			result,
			{
				internalChunkIds: new Set(
					candidateItems.flatMap((item) => item.candidates.map((candidate) => candidate.chunkId)),
				),
				externalTexts: new Set(coverageDoc.clauses.map((c) => c.text)),
				internalTexts: new Set(
					candidateItems.flatMap((item) => item.candidates.map((candidate) => candidate.text)),
				),
				checkedCount: coverageDoc.clauses.length,
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
