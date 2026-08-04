import { randomUUID } from "node:crypto";
import type { ProviderProfile } from "../env/provider-profile.ts";
import { type FastPathSpec, pluginName, pluginOptions, type RuntimeLimits, type RuntimeSpec } from "../spec/types.ts";
import type { ToolsetRegistry } from "../toolsets/registry.ts";
import { type Assembled, type AssembleOptions, assemble, type PluginToolCallEvent } from "./assembler.ts";
import type { LimitKind, LimitState, RunOptions, RunResult, RunStatus, Runtime, RuntimeEvent } from "./contract.ts";
import { mergeHitsRoundRobin, type RetrievalHit } from "./merge-hits.ts";
import { extractJsonBlock, validateOutputContract } from "./output-contract.ts";
import type { PluginContext, PluginRegistry } from "./plugin-registry.ts";

export type FastPathVerdict = { accept: true } | { accept: false; reason: string };

interface FastAnswerShape {
	finish_reason?: unknown;
	confidence?: unknown;
	basis?: unknown;
}

/**
 * 规格 §3 的升级判据。**四条全过才收下**,任何一条不过都升级 ——
 * 方向是「宁可多升级,不可答差」。
 *
 * 判据 1 走 `validateOutputContract`(与 C6 判官**同一份**实现),但**不注册 C6 judge**:
 * `createOutputContractJudge` 的 `onExhausted` 是 "error",`maxRepairAttempts: 0` 会让第一次
 * 不通过就把 run 判成 error,而快路径要的是升级,不是失败。
 */
export function judgeFastPathOutput(text: string, schema: unknown, clauseIds: readonly string[]): FastPathVerdict {
	const checked = validateOutputContract(text, schema, clauseIds);
	if (!checked.ok) return { accept: false, reason: `输出契约不通过:${checked.detail}` };

	const json = checked.value as FastAnswerShape;
	if (json.finish_reason !== "stop") {
		return { accept: false, reason: `finish_reason 不是 "stop"(实际:${String(json.finish_reason)})` };
	}
	if (json.confidence !== "high" && json.confidence !== "medium") {
		return { accept: false, reason: `confidence 不在 {high, medium}(实际:${String(json.confidence)})` };
	}
	// 纵深防御,当前不可达:能走到这里意味着判据 1(`validateOutputContract`)已通过、且
	// `finish_reason === "stop"`;而 `output-contract.ts` 的 `checkConditional` 已经把
	// "finish_reason 为 stop 且 basis 为空" 判进判据 1 的失败分支(`basis` 非数组时被同一段
	// 三元表达式塌成 `[]`,同样命中该分支),所以这里的条件此刻恒为 false —— 实测把这个 if
	// 整块删掉,`fast-path-runtime.test.ts` 全部用例照样全绿。留着不删是防 `checkConditional`
	// 未来改动后这条判据悄悄失去着落;不是在断言它现在拦得住什么。
	if (!Array.isArray(json.basis) || json.basis.length === 0) {
		return { accept: false, reason: "basis 为空" };
	}
	return { accept: true };
}

/**
 * 模型① 只产出一个 JSON **对象** `{"queries": [...]}`,`queries` 是检索词字符串数组。
 * 解析失败 / `queries` 缺失或不是数组 / 过滤后为空 ⇒ 调用方**降级用抢跑那次的原始 query
 * 结果继续,不升级**(规格 §2.4)—— 抢跑本来就在跑,代价为零。
 *
 * **复用 `extractJsonBlock`,不另写一套围栏/裸文本提取逻辑**:`extractJsonBlock` 只认花括号
 * (`indexOf("{")` / `lastIndexOf("}")`),模型①若吐裸数组 `["...", "..."]` 会被判
 * `absent`——这不是让模型改吐数组、自己再写一遍围栏优先/退回裸文本/三态区分的提取逻辑就能
 * 绕开的事:那样会在仓里留下两份形状相同、只是取 `[]` 还是 `{}` 的提取实现,而这个仓库刚
 * 为「两处逐字重复的提取逻辑」付过一次代价(C3 与 C6 的反幻觉 clause_id 提取曾经各写一份,
 * 后来合并成 `extractClauseIds`,理由正是两处会漂移、让两个判官对同一份文本解读不同)。
 * 让模型①也吐一个 JSON 对象、`queries` 是它的一个字段,两次模型调用因此共用同一份提取
 * 实现,行为恒定一致。
 *
 * ⚠ 这也约束了 `fastPath.rewritePrompt`(构造检索词那次的 user 消息模板)的措辞:必须要求
 * 模型①输出 `{"queries": [...]}`,不是裸数组——那个 prompt 文件不由本任务创建。
 */
export function parseRewriteTerms(text: string): string[] {
	const extracted = extractJsonBlock(text);
	if (extracted.kind !== "ok") return [];
	const queries = (extracted.value as { queries?: unknown }).queries;
	if (!Array.isArray(queries)) return [];
	return queries.filter((term): term is string => typeof term === "string" && term.trim().length > 0);
}

/**
 * 由主 spec 合成阶段 1 的 RuntimeSpec。
 *
 * 三处「去掉」都是规格 §4 的护栏形态,不是省事:
 * - `stopPolicy`(C3):它唯一的动作是 reprompt = 整份答案重新生成,破坏「模型调用固定 2 次」。
 *   且 §2.3 已保证阶段 1 里模型看得见的条款都有正文 ⇒ 它要拦的事结构上不会发生。
 * - `outputContract`(C6 judge):`onExhausted` 是 "error",第一次不过就把 run 判成 error,
 *   而快路径要的是升级。校验仍然做,走 `judgeFastPathOutput`(同一份实现)。
 * - `appendSystemPrompt`:输出契约必须待在 answerPrompt(user 消息)里,不能进 system prompt
 *   —— 两次模型调用共用 system prompt,写进去会让模型① 直接吐 JSON。
 */
export function deriveFastSpec(spec: RuntimeSpec): RuntimeSpec {
	const fp = spec.fastPath;
	if (!fp) throw new Error(`RuntimeSpec "${spec.id}": deriveFastSpec called on a spec without fastPath`);
	// ⚠ `fp.maxChars` 传下去之后其实**不生效**:`result-budget` 插件挂在 pi 的 `tool_result`
	// hook 上做截断,而阶段 1 的检索全部经 `Assembled.callTool` 直打 `tool.execute()`,绕过
	// pi 的 agent loop、不触发任何 hook(assembler.ts 里 `callTool` 那段实现与文档字符串)。
	// 证据块大小眼下只由 `fastPath.maxClauses` 间接兜住,`maxChars` 这份配置整条链路都是空转。
	// 不是本任务改的范围(改配置留给规格与计划那边同步),这里只如实记录,别让人以为它有效。
	//
	// 主 spec 没配 `resultPolicy` 时,下面的三元表达式会连同 `fp.maxChars` 一起静默丢弃 ——
	// 既然 `maxChars` 本来就不生效,这不构成额外的实害,不用为它单独分支。
	const resultPolicy =
		fp.maxChars === undefined || spec.resultPolicy === undefined
			? spec.resultPolicy
			: {
					name: pluginName(spec.resultPolicy),
					options: { ...pluginOptions(spec.resultPolicy), maxChars: fp.maxChars },
				};
	return {
		...spec,
		id: `${spec.id}#fast`,
		systemPrompt: fp.systemPrompt,
		appendSystemPrompt: undefined,
		thinkingLevel: fp.thinkingLevel ?? spec.thinkingLevel,
		limits: fp.limits,
		stopPolicy: undefined,
		outputContract: undefined,
		resultPolicy,
		fastPath: undefined,
	};
}

export interface FastPathRuntimeOptions {
	/** 主 spec(含 fastPath)。内部自己 deriveFastSpec,调用方不必先派生。 */
	spec: RuntimeSpec;
	profile: ProviderProfile;
	registry: PluginRegistry;
	toolsets: ToolsetRegistry;
	cwd: string;
	agentDir: string;
	/** **主 spec 的** outputContract schema —— 升级判据要用它。 */
	outputContractSchema: unknown;
	skillPaths?: string[];
	modelOverride?: AssembleOptions["modelOverride"];
}

export interface FastPathRun {
	verdict: FastPathVerdict;
	result: RunResult;
}

export interface FastPathRuntime extends Runtime {
	runFast(input: string, opts?: RunOptions): Promise<FastPathRun>;
	/** 测试缝:装配后模型实际看得见的工具名。生产代码不读它,只有测试靠它锁住
	 *  `setActiveToolsByName([])` 那一行——faux 模型本来就不调工具,删掉那行不会有任何测试
	 *  翻红,这个探针把「模型看不到工具」这条不变量单独变成可断言的。 */
	activeToolNamesForTest(): string[];
}

interface DetailItem {
	clause_id: string;
	text?: unknown;
	[key: string]: unknown;
}

/** 从 search_policy 的返回里取 hits;形状不对就当空列表,不抛 —— 一次检索失败不该打死整条路径。 */
function toHits(raw: unknown): RetrievalHit[] {
	const hits = (raw as { hits?: unknown } | null)?.hits;
	if (!Array.isArray(hits)) return [];
	return hits.filter(
		(h): h is RetrievalHit =>
			typeof h === "object" && h !== null && typeof (h as { clause_id?: unknown }).clause_id === "string",
	);
}

/**
 * `get_clause_detail` 的 `items` 里,"确实取到了正文"这件事只能靠 `text` 字段自己判断,不能
 * 只看这一行是否存在。
 *
 * audit-ai 的 `get_clause_detail.py`(:100-101,"正文缺失是 null,不是错误")对"anchor 存在但
 * 正文缺失"的条款照样把它塞进 `items`,只是 `text` 是 `null`——这类条款**不落 `not_found`**
 * (那个数组只装 anchor 压根查不到的 id,:105-111)。这种行只有标题元数据,模型看不到正文却
 * 能引用它;若 `clauseIds` 沿用"这一行在 `items` 里出现过"当判据,C6 的反幻觉校验会认可这条
 * 引用——规格 §2.3 的"阶段 1 里模型看得见的条款都有正文"这条语义保证就不成立了,而那正是
 * §4.2 摘掉 C3(sufficiency-gate)**两条理由之一**(另一条独立成立:C3 的动作是 reprompt,
 * 破坏「模型调用固定 2 次」,不依赖 §2.3 这条语义保证。两条理由见 `deriveFastSpec` 上方注释)。
 */
function hasFetchedText(item: unknown): item is DetailItem {
	if (typeof item !== "object" || item === null) return false;
	if (typeof (item as { clause_id?: unknown }).clause_id !== "string") return false;
	const text = (item as { text?: unknown }).text;
	return typeof text === "string" && text.trim().length > 0;
}

/** `limitState.tripped` 的人可读描述。快路径结构上不用 `maxTurns`(固定 2 次模型调用,
 *  `FastPathSpec.limits` 的文档已注明),这里仍覆盖它只是为了穷尽 `LimitKind` 的类型,
 *  不代表期望它触发。 */
function describeTripped(kind: LimitKind, limits: RuntimeLimits): string {
	if (kind === "runTimeout") return `阶段 1 超时(${limits.runTimeoutMs}ms)`;
	if (kind === "maxCostUsd") return `阶段 1 撞到费用上限(maxCostUsd=${limits.maxCostUsd})`;
	if (kind === "maxTotalTokens") return `阶段 1 撞到 token 上限(maxTotalTokens=${limits.maxTotalTokens})`;
	return `阶段 1 撞到限额:${kind}`;
}

/** 把取到正文的条款渲染成给模型②看的正文块。**只渲染 items** —— 见下面 clauseIds 的注释。 */
function renderEvidence(items: readonly DetailItem[], byId: ReadonlyMap<string, RetrievalHit>): string {
	return items
		.map((item, index) => {
			const hit = byId.get(item.clause_id);
			const lines = [
				`[${index + 1}] clause_id: ${item.clause_id}`,
				`  doc_title: ${String(item.doc_title ?? "")}`,
				`  clause_path: ${String(item.clause_path ?? "")}`,
				`  status: ${String(item.status ?? "")}`,
				`  source_code: ${String(item.source_code ?? "")}`,
				`  source_doc_id: ${String(item.source_doc_id ?? "")}`,
				`  corpus_type: ${String(hit?.corpus_type ?? "")}`,
				`  score: ${hit?.score === undefined ? "null" : String(hit.score)}`,
				`  正文: ${String(item.text ?? "")}`,
			];
			return lines.join("\n");
		})
		.join("\n\n");
}

export async function createFastPathRuntime(options: FastPathRuntimeOptions): Promise<FastPathRuntime> {
	const maybeFp = options.spec.fastPath;
	if (!maybeFp) throw new Error(`RuntimeSpec "${options.spec.id}": createFastPathRuntime called without fastPath`);
	// `fp` 显式标注非 optional 类型(而不是直接用上面narrow 过的 `maybeFp`):`runFast` /
	// `runFastInner` 是**嵌套的具名函数**,TS 的控制流缩窄不会跨函数边界传播到它们体内
	// (即便捕获的是 `const`)——嵌套函数里看到的还是 `maybeFp` declared 的
	// `FastPathSpec | undefined`。给 `fp` 一个自己的、非 optional 的声明类型,嵌套函数里
	// 引用到的就是这个类型本身,不需要再缩窄。
	const fp: FastPathSpec = maybeFp;
	// 装配期失败要早要响(全仓一贯纪律,`createSessionRuntime` 对 outputContract/schema 的
	// 缺失校验是同一类护栏)。`outputContractSchema` 字段类型是 `unknown`,TS 拦不住调用方漏传
	// `undefined`——而阶段 2 每一次作答都要靠它判定 accept/escalate,不是可选项。漏传时的
	// 实际后果已经跑过:`judgeFastPathOutput` 在 `validateOutputContract` 内部对 `undefined`
	// 的 schema 做 `Value.Check` 会抛 `Cannot use 'in' operator to search for 'type' in
	// undefined`,这个 TypeError 会被 `runFast()` 的 catch 吞成一句看不出病因的"阶段 1 抛错",
	// 快路径因此对每一次调用都静默升级。装配期直接响亮拒绝,不留这个坑给运行期猜。
	if (options.outputContractSchema === undefined) {
		throw new Error(
			`RuntimeSpec "${options.spec.id}": createFastPathRuntime requires outputContractSchema ` +
				`(it is used to judge every stage-2 answer; omitting it turns every run into a silent escalation)`,
		);
	}
	const fastSpec = deriveFastSpec(options.spec);

	let currentRunId = "";
	let currentInput = "";
	let seq = 0;
	const listeners = new Set<(event: RuntimeEvent) => void>();

	function emit(type: string, payload: unknown): void {
		const enveloped: RuntimeEvent = {
			runId: currentRunId,
			specId: options.spec.id,
			seq: seq++,
			ts: Date.now(),
			type,
			payload,
		};
		// 与 session-runtime.ts 的 fan-out 同一条纪律:一个监听器抛不能打死整条路径。
		for (const listener of listeners) {
			try {
				listener(enveloped);
			} catch (error) {
				console.error(`[FastPathRuntime] event subscriber threw for "${type}"; continuing fan-out`, error);
			}
		}
	}

	// limits 插件(由 assemble() 从 fastSpec.limits 无条件挂载)与我们自己的 runTimeoutMs
	// 定时器共写这一个 LimitState.tripped——同一份单一事实来源,`checkPreempted()` 只需要
	// 查这一处。命名为独立的 const(而不是内联在 pluginContext 字面量里)是因为 runFast()
	// 也要读它。
	const limitState: LimitState = { turns: 0 };

	// `assembled` 要等 assemble() 返回才有值。下面 pluginContext 的 getSession 闭包要在
	// **构造 pluginContext 字面量时**就引用它——用 `let ...!:` 声明(与 session-runtime.ts
	// 的 `assembled` 同一处理)而不是 `const assembled = await assemble(...)` 之后再原地内联
	// pluginContext:后者会在同一函数作用域内让闭包引用一个文本顺序上还没声明的 `const`,
	// 触发 TS2448。
	//
	// ⚠ 这个闭包在 fastSpec 眼下挂载的两个插件(limits、result-budget)身上确实只在 hook
	// 回调里才被调用,但那是这两个插件恰好这么写,不是 PluginContext 的契约保证:
	// `assemble()` 对插件工厂的调用是**同步**的、发生在 assemble() 返回之前
	// (`instantiatePlugins()`——`test/assembler.test.ts` 的 "PluginContext.callTool(C3 接线)"
	// 那组用例就是在工厂体内**同步**调 `ctx.callTool` 的),同一个 PluginContext 上的
	// `getSession` 原则上可以被将来某个装了 extraPlugins 的插件同样同步调用。裸读
	// `assembled.session` 在那种情况下只会抛一句不指向病因的
	// "Cannot read properties of undefined",所以下面的 `getSession` 自带一道描述性护栏
	// (与 session-runtime.ts 的 `getSession` 同款),不指望这条注释兜底。
	let assembled!: Assembled;
	// `abort` 不需要同一道护栏:装配期(assembled 还没有值)调用它没有任何东西可 abort,
	// 让它是个安全的空操作即可——这里照抄 session-runtime.ts 的 `abortFn` 模式,先给一个
	// 空操作默认值,assemble() 返回之后再指向真正会话。
	let abortFn: () => void = () => {};

	const pluginContext: Omit<PluginContext, "callTool"> = {
		getRunId: () => currentRunId,
		getSession: () => {
			if (!assembled) {
				throw new Error(
					`FastPathRuntime "${options.spec.id}": PluginContext.getSession() was called during assembly, ` +
						"before the AgentSession exists; plugin factories must defer session access to hook callbacks",
				);
			}
			return assembled.session;
		},
		abort: () => abortFn(),
		limitState,
		// 阶段 1 不注册任何判官(deriveFastSpec 已摘掉 stopPolicy / outputContract),
		// 但接口要求这个字段存在。若将来有插件想在这里登记判官,是设计错误 ——
		// 快路径的确定性建立在「模型调用固定 2 次」上,判官会 reprompt。
		registerFinalJudge: () => {
			throw new Error(
				"FastPathRuntime does not support final judges (a judge would reprompt and break the fixed 2-call shape)",
			);
		},
		getRunInput: () => currentInput,
	};

	assembled = await assemble({
		spec: fastSpec,
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

	// session-runtime.ts 的 abortFn 同一条纪律:这条回调从同步的 hook(limits 插件的
	// turn_end)或下面 runFast() 里的 setTimeout 触发,两者都无法 await 它——session.abort()
	// 是异步的、可能 reject,不接住会变成未处理的 promise rejection(现代 Node 视为致命)。
	// 这是尽力而为的清理路径,不是公开的 Runtime.abort() 契约(下面 return 里那个),所以
	// 失败在这里打日志后吞掉,而不是往上传播。
	abortFn = () => {
		void assembled.session.abort().catch((error: unknown) => {
			console.error(
				`[FastPathRuntime] abort() triggered by a limit/timeout failed for spec "${options.spec.id}"`,
				error,
			);
		});
	};

	// 🔴 模型在阶段 1 **看不到任何工具**。检索全由下面的代码经 assembled.callTool 发起。
	// 不能靠 spec 里写 `tools: []` —— validate.ts 明确拒绝空白名单
	// ("tools must be a non-empty whitelist"),`spec.tools` 与那条校验都不动。
	assembled.session.setActiveToolsByName([]);

	const session = assembled.session;
	const id = randomUUID();
	let lastActiveAt = Date.now();
	let modelCalls = 0;

	async function promptOnce(text: string): Promise<string> {
		modelCalls += 1;
		await session.prompt(text);
		lastActiveAt = Date.now();
		return session.getLastAssistantText() ?? "";
	}

	/** 升级(verdict.accept===false)与真正的运行期失败共用的落地信息。缺省即 status:"completed"。 */
	interface EscalationOutcome {
		status: Exclude<RunStatus, "completed">;
		errorMessage: string;
		limit?: LimitKind;
	}

	// I-3:`errorMessage` 此前**没有任何调用点传值**——阶段 1 抛错 / 超时 / 判负的分支全部
	// 落地成 `{status:"completed", output:<改写词或未过契约的那段文本>}`。这不只是措辞不准:
	// `server/routes.ts` 的 `toWireResult` 只看 `status !== "completed"` 就放行填 `answer`
	// (2026-07-31 复审 Important 记录的同一类闸门),一旦 `run()`(见下面 return 里的警告)
	// 被接线,Java 会原样收到一份从未通过 `judgeFastPathOutput` 的 JSON。`verdict.accept` 与
	// `result.status` 因此必须同步:任何 `{accept:false}` 都要有一个非 "completed" 的
	// status,这里以 `EscalationOutcome` 参数统一收口,不再让某个分支漏传。
	function normalize(runId: string, startedAt: number, output: string, outcome?: EscalationOutcome): RunResult {
		const stats = session.getSessionStats();
		return {
			runId,
			specId: options.spec.id,
			status: outcome?.status ?? "completed",
			output: output.length > 0 ? output : undefined,
			errorMessage: outcome?.errorMessage,
			limit: outcome?.limit,
			usage: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				total: stats.tokens.total,
				cost: stats.cost,
			},
			turns: modelCalls,
			durationMs: Date.now() - startedAt,
			judgeAttempts: {},
		};
	}

	/**
	 * 挂钟超时与限额插件(maxCostUsd/maxTotalTokens,由 assemble() 从 fastSpec.limits 无条件
	 * 挂载的 limits 插件负责计数)必须在两次模型调用之间也查一次,不能只在模型②返回之后查:
	 * runTimeoutMs 的 timer 一次性、limits 插件的 turn_end 钩子命中后 `if (state.tripped)
	 * return` 永久停手(final-judge.ts 的 runFinalJudges 注释详述过这个组合),而 abort 本身
	 * 在 pi 里不是粘滞状态 —— 三条叠起来:若只在最后查一次,超时/撞限额一旦发生在模型①期间
	 * 或两次检索期间,代码会带着"没有任何上限"的状态走完剩下的流程,发出第二次**完全无上限**
	 * 的模型调用,快路径存在的意义(落进 Java 的 30s 窗口)反而被它自己吃掉。
	 */
	function checkPreempted(runId: string, startedAt: number, output: string): FastPathRun | undefined {
		const tripped = limitState.tripped;
		if (!tripped) return undefined;
		const reason = describeTripped(tripped, fp.limits);
		emit("fast_path_escalated", { reason });
		return {
			verdict: { accept: false, reason },
			// status 一律 "limit_exceeded",runTimeout 不例外 —— 与 session-runtime.ts 的
			// classify() 同口径(tripped 就是 "limit_exceeded",不看 tripped 的具体取值),
			// 也是 docs/java-answer-contract.md:82 写死的形态("limit 仅 status ===
			// "limit_exceeded" 时有意义")。"aborted" 在 run-manager.ts 里专指用户主动取消
			// (finishAsAborted),把挂钟超时也映射成 "aborted" 会让 Java 侧以为是用户撤销了
			// 请求,排障方向被带偏;而 `limit` 字段一旦被 status !== "limit_exceeded" 的结果
			// 带出去,正是 session-runtime.ts 那段注释点名过的"下游按 status==='limit_exceeded'
			// 记预算超支会直接漏记"那种自相矛盾组合。
			result: normalize(runId, startedAt, output, {
				status: "limit_exceeded",
				errorMessage: reason,
				limit: tripped,
			}),
		};
	}

	async function runFast(input: string, opts?: RunOptions): Promise<FastPathRun> {
		const runId = opts?.runId ?? randomUUID();
		currentRunId = runId;
		currentInput = input;
		modelCalls = 0;
		// 每次 run() 开头重置:不重置的话,同一个 runtime 上的第二次 run() 会继承上一次已经
		// tripped 的 limitState,一进来就被 checkPreempted() 判掉(与 session-runtime.ts 的
		// run() 开头重置 state.turns/state.tripped 同一条纪律)。
		limitState.turns = 0;
		limitState.tripped = undefined;
		const startedAt = Date.now();

		// 挂钟硬顶。**必须有** —— 快路径的全部意义是落进 Java 的 30s 窗口,一次挂住的
		// 模型调用会把两条路径的时间**相加**,比不做快路径还慢。
		// 与 SessionRuntime 一样,timer 住在这里而不是 limits 插件里:插件只看 turn_end,
		// 看不见轮内挂住。命中时写同一个 limitState.tripped(固定值 "runTimeout"),与
		// limits 插件共享同一份事实来源,checkPreempted() 只需要查一处。
		let timer: NodeJS.Timeout | undefined;
		if (fp.limits.runTimeoutMs !== undefined) {
			timer = setTimeout(() => {
				if (limitState.tripped) return; // limits 插件已经先一步 trip,不重复覆盖
				limitState.tripped = "runTimeout";
				abortFn();
			}, fp.limits.runTimeoutMs);
		}
		try {
			return await runFastInner(runId, input, startedAt);
		} catch (error) {
			// 规格 §7:阶段 1 任何抛错(含超时/撞限额期间下游调用被 abort 打断导致的抛错)都
			// **升级**,不落终态失败 —— 阶段 2 还没跑过。
			const tripped = limitState.tripped;
			const reason = tripped
				? describeTripped(tripped, fp.limits)
				: `阶段 1 抛错:${error instanceof Error ? error.message : String(error)}`;
			emit("fast_path_escalated", { reason });
			return {
				verdict: { accept: false, reason },
				// status 同 checkPreempted() 的口径:tripped 一律 "limit_exceeded"(含
				// runTimeout),不映射成 "aborted" —— 见 checkPreempted 上方的注释。
				result: normalize(runId, startedAt, session.getLastAssistantText() ?? "", {
					status: tripped ? "limit_exceeded" : "error",
					errorMessage: reason,
					limit: tripped,
				}),
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async function runFastInner(runId: string, input: string, startedAt: number): Promise<FastPathRun> {
		// 抢跑:用原始 query 先检索一次,与模型①**并行**。唯一目的是吃掉检索后端首次调用的
		// 模型懒加载耗时(规格 §1.2)。命中结果一并保留,不是白跑。
		// catch 成空列表:抢跑失败不该打死整条路径 —— 改写词那几次检索还没跑。
		const headStart = assembled
			.callTool("search_policy", { query: input })
			.then(toHits)
			.catch(() => [] as RetrievalHit[]);

		const rewriteText = await promptOnce(`${fp.rewritePrompt}\n\n${input}`);
		// 早退检查 1/3:模型①这一轮就可能撞上超时或限额,继续往下走会发出一次没有任何上限的
		// 检索 + 模型②调用(见 checkPreempted 的文档)。
		const preemptedAfterRewrite = checkPreempted(runId, startedAt, rewriteText);
		if (preemptedAfterRewrite) return preemptedAfterRewrite;

		const terms = parseRewriteTerms(rewriteText);
		if (terms.length === 0) {
			// M-5:这本身是规格 §2.4 认可的降级(用抢跑结果继续、不升级,见下面),不发
			// fast_path_escalated——但"永远静默"意味着哪天 fastPath.rewritePrompt 被改歪
			// (比如不再要求模型输出 {"queries": [...]}),快路径会**永久退化**成只用抢跑那
			// 一次检索,而且没有任何信号能让人发现。留一条进程日志,不升成事件。
			console.error(
				`[FastPathRuntime] stage 1 rewrite for spec "${options.spec.id}" produced no usable queries; ` +
					"falling back to the head-start retrieval only. If this keeps happening, fastPath.rewritePrompt " +
					'is probably no longer asking the model for {"queries": [...]}.',
			);
		}
		// 解析失败 / 空数组 ⇒ **不升级**,用抢跑那次的结果继续(规格 §2.4)。抢跑本来就在跑,
		// 代价为零。这里刻意不发第二次模型调用去重试改写 —— 那会破坏「固定 2 次」。
		const rewriteLists = await Promise.all(
			terms.map((term) =>
				assembled
					.callTool("search_policy", { query: term })
					.then(toHits)
					.catch(() => [] as RetrievalHit[]),
			),
		);

		// lists[0] 是抢跑那次 —— 轮询交错时它排第一位(merge-hits.ts 的约定)。
		const merged = mergeHitsRoundRobin([await headStart, ...rewriteLists], fp.maxClauses);
		if (merged.length === 0) {
			const reason = "检索无命中";
			emit("fast_path_escalated", { reason });
			return {
				verdict: { accept: false, reason },
				result: normalize(runId, startedAt, rewriteText, { status: "error", errorMessage: reason }),
			};
		}

		// 一次取全 —— `get_clause_detail` 的 clause_ids 是数组、minItems:1、无上限。
		const detail = (await assembled.callTool("get_clause_detail", {
			clause_ids: merged.map((hit) => hit.clause_id),
		})) as { items?: unknown } | null;
		// C-1:`hasFetchedText` 同时要求 clause_id 与非空 text —— "详情行回来了"不等于
		// "正文取到了",见该函数上方的文档。
		const items = (Array.isArray(detail?.items) ? detail.items : []).filter(hasFetchedText);
		if (items.length === 0) {
			const reason = "检索命中但一条正文都没取到";
			emit("fast_path_escalated", { reason });
			return {
				verdict: { accept: false, reason },
				result: normalize(runId, startedAt, rewriteText, { status: "error", errorMessage: reason }),
			};
		}

		// 🔴 clauseIds 自维护(规格 §5)。
		//
		// C6 反幻觉的 clauseIds 数据源是 session.subscribe() 的 tool_execution_end,而阶段 1 的
		// 模型**从不自己调工具** ⇒ 那条通路恒空 ⇒ checkConditional 会把每一条 basis 都判成臆造
		// (output-contract.ts 的 checkConditional 注释里列的第 3 种病因「本 run 压根没调用过
		// 任何工具」正是这个)。
		//
		// 取值是 **items 的 id,不是 merged 的 id** —— 两者可以不同,且不只是"merged 里某条
		// PG 查不到正文"这一种(那种落进 detail.not_found,`hasFetchedText` 已经把它连同
		// "详情行回来但 text 是 null"的那种一起滤掉了,见该函数文档):
		//   - 少收 ⇒ 真引用被误判臆造;
		//   - 多收(比如用 merged,或用"详情行存在"当判据而不检查 text) ⇒ 模型能引用一条
		//     自己只看过标题、没看过正文的条款,而那正是本项目取证纪律要拦的事
		//     (agent 路径的 system.md:12 写的是同一条规矩)。
		// 不变量:**渲染进 prompt 的集合 === clauseIds 集合**,两者必须由同一个 items 派生。
		const clauseIds = items.map((item) => item.clause_id);
		const byId = new Map(merged.map((hit) => [hit.clause_id, hit]));

		// 早退检查 2/3:两次 search_policy(Promise.all)+ 一次 get_clause_detail 这几步检索
		// 期间也可能撞上超时或限额,发出模型②之前必须再查一次。
		const preemptedBeforeAnswer = checkPreempted(runId, startedAt, rewriteText);
		if (preemptedBeforeAnswer) return preemptedBeforeAnswer;

		const answerText = await promptOnce(`${fp.answerPrompt}\n\n${renderEvidence(items, byId)}`);
		// 早退检查 3/3:abort 在 pi 里不是粘滞状态(见 final-judge.ts 里 runFinalJudges 对这件
		// 事的说明),超时/撞限额后 prompt() 可能正常返回一段被截断的文本 —— 必须自己复查一次,
		// 否则半截答案会被当成合格结果收下。
		const preemptedAfterAnswer = checkPreempted(runId, startedAt, answerText);
		if (preemptedAfterAnswer) return preemptedAfterAnswer;

		// 判官读的、与最终交给调用方的 `RunResult.output`,必须是**同一段**文本:两者都来自
		// `promptOnce` 的返回值(`session.getLastAssistantText()`),这里的 `answerText` 就是
		// 那份返回值,原样传给 `judgeFastPathOutput` 与 `normalize`,不重新读取一次 ——
		// 重新读取会有极小的窗口读到助手消息被后续事件(比如下一次 prompt)覆盖后的状态。
		const verdict = judgeFastPathOutput(answerText, options.outputContractSchema, clauseIds);
		if (!verdict.accept) emit("fast_path_escalated", { reason: verdict.reason });
		return {
			verdict,
			result: normalize(
				runId,
				startedAt,
				answerText,
				// I-3:verdict 与 result.status 必须同步——被判负的答案不能带着 "completed"
				// 状态往下游走(见 normalize 上方的注释)。
				verdict.accept ? undefined : { status: "error", errorMessage: verdict.reason },
			),
		};
	}

	return {
		id,
		specId: options.spec.id,
		sessionId: session.sessionId,
		runFast,
		// ⚠ `run()` **不看 verdict**,原样回阶段 1 的结果 —— 它只是为了满足 `Runtime` 接口,
		// 不是快路径的推荐用法。真正要消费快路径的调用方必须读 `runFast()`,看着 verdict 自己
		// 决定收下这份输出、还是转去升级路径重跑——那部分编排留给后续任务,本任务不建它,
		// 这里只负责把 `runFast()` 这个入口留好。直接拿 `run()` 的返回值当终态用,等于把一份
		// 已经判定「该升级」的输出当成合格结果交下去:与 `toWireResult`(server/routes.ts)
		// 已经收紧的「只在 status === "completed" 时才填 answer」是同一类闸门缺失
		// (2026-07-31 复审 Important 记录在案)——被 C6 拒掉的臆造应答不能因为解析得出语法
		// 合法的 JSON,就被当成已校验的答案继续往下游走。
		run: async (input: string, opts?: RunOptions) => (await runFast(input, opts)).result,
		activeToolNamesForTest: () => session.getActiveToolNames(),
		steer: (text: string) => session.steer(text),
		followUp: (text: string) => session.followUp(text),
		abort: () => session.abort(),
		waitForIdle: () => session.waitForIdle(),
		subscribe: (listener: (event: RuntimeEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get isIdle() {
			return session.isIdle;
		},
		get lastActiveAt() {
			return lastActiveAt;
		},
		snapshot: () => ({ sessionId: session.sessionId, sessionFile: session.sessionFile ?? undefined }),
		dispose: async () => {
			listeners.clear();
			await assembled.dispose();
		},
	};
}
