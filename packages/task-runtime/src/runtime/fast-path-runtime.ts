import { randomUUID } from "node:crypto";
import type { ProviderProfile } from "../env/provider-profile.ts";
import { type FastPathSpec, pluginName, pluginOptions, type RuntimeSpec } from "../spec/types.ts";
import type { ToolsetRegistry } from "../toolsets/registry.ts";
import { type Assembled, type AssembleOptions, assemble, type PluginToolCallEvent } from "./assembler.ts";
import type { RunOptions, RunResult, Runtime, RuntimeEvent } from "./contract.ts";
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

	// `assembled` 要等 assemble() 返回才有值,但下面 pluginContext 的几个闭包
	// (getSession/abort)要在**构造 pluginContext 字面量时**就引用它——用 `let ...!:` 声明
	// (与 session-runtime.ts 的 `assembled` 同一处理)而不是 `const assembled = await
	// assemble(...)` 之后再原地内联 pluginContext:后者会在同一函数作用域内让这些闭包引用一个
	// 文本顺序上还没声明的 `const`,触发 TS2448。这些闭包只在 assemble() 已经 resolve 之后
	// (某个 hook / 判官回调里)才会被真正调用,所以运行时时序没问题,问题只在编译期的声明顺序。
	let assembled!: Assembled;

	const pluginContext: Omit<PluginContext, "callTool"> = {
		getRunId: () => currentRunId,
		getSession: () => assembled.session,
		abort: () => void assembled.session.abort().catch(() => {}),
		limitState: { turns: 0 },
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

	function normalize(runId: string, startedAt: number, output: string, errorMessage?: string): RunResult {
		const stats = session.getSessionStats();
		return {
			runId,
			specId: options.spec.id,
			status: errorMessage === undefined ? "completed" : "error",
			output: output.length > 0 ? output : undefined,
			errorMessage,
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

	async function runFast(input: string, opts?: RunOptions): Promise<FastPathRun> {
		const runId = opts?.runId ?? randomUUID();
		currentRunId = runId;
		currentInput = input;
		modelCalls = 0;
		const startedAt = Date.now();

		// 挂钟硬顶。**必须有** —— 快路径的全部意义是落进 Java 的 30s 窗口,一次挂住的
		// 模型调用会把两条路径的时间**相加**,比不做快路径还慢。
		// 与 SessionRuntime 一样,timer 住在这里而不是 limits 插件里:插件只看 turn_end,
		// 看不见轮内挂住。超时 ⇒ abort ⇒ 下面的 try/catch 转成升级,不是把 run 判成 error。
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		if (fp.limits.runTimeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				void session.abort().catch(() => {});
			}, fp.limits.runTimeoutMs);
		}
		try {
			return await runFastInner(runId, input, startedAt, () => timedOut);
		} catch (error) {
			// 规格 §7:阶段 1 任何抛错都**升级**,不落终态失败 —— 阶段 2 还没跑过。
			const reason = timedOut
				? `阶段 1 超时(${fp.limits.runTimeoutMs}ms)`
				: `阶段 1 抛错:${error instanceof Error ? error.message : String(error)}`;
			emit("fast_path_escalated", { reason });
			return {
				verdict: { accept: false, reason },
				result: normalize(runId, startedAt, session.getLastAssistantText() ?? ""),
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async function runFastInner(
		runId: string,
		input: string,
		startedAt: number,
		isTimedOut: () => boolean,
	): Promise<FastPathRun> {
		// 抢跑:用原始 query 先检索一次,与模型①**并行**。唯一目的是吃掉检索后端首次调用的
		// 模型懒加载耗时(规格 §1.2)。命中结果一并保留,不是白跑。
		// catch 成空列表:抢跑失败不该打死整条路径 —— 改写词那几次检索还没跑。
		const headStart = assembled
			.callTool("search_policy", { query: input })
			.then(toHits)
			.catch(() => [] as RetrievalHit[]);

		const rewriteText = await promptOnce(`${fp.rewritePrompt}\n\n${input}`);
		const terms = parseRewriteTerms(rewriteText);
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
			const result = normalize(runId, startedAt, rewriteText);
			return { verdict: { accept: false, reason: "检索无命中" }, result };
		}

		// 一次取全 —— `get_clause_detail` 的 clause_ids 是数组、minItems:1、无上限。
		const detail = (await assembled.callTool("get_clause_detail", {
			clause_ids: merged.map((hit) => hit.clause_id),
		})) as { items?: unknown } | null;
		const items = (Array.isArray(detail?.items) ? detail.items : []).filter(
			(item): item is DetailItem =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as { clause_id?: unknown }).clause_id === "string",
		);
		if (items.length === 0) {
			const result = normalize(runId, startedAt, rewriteText);
			return { verdict: { accept: false, reason: "检索命中但一条正文都没取到" }, result };
		}

		// 🔴 clauseIds 自维护(规格 §5)。
		//
		// C6 反幻觉的 clauseIds 数据源是 session.subscribe() 的 tool_execution_end,而阶段 1 的
		// 模型**从不自己调工具** ⇒ 那条通路恒空 ⇒ checkConditional 会把每一条 basis 都判成臆造
		// (output-contract.ts 的 checkConditional 注释里列的第 3 种病因「本 run 压根没调用过
		// 任何工具」正是这个)。
		//
		// 取值是 **items 的 id,不是 merged 的 id** —— 两者可以不同:merged 里的某条可能
		// PG 查不到正文(落进 detail.not_found)。
		//   - 少收 ⇒ 真引用被误判臆造;
		//   - 多收(比如用 merged) ⇒ 模型能引用一条自己只看过标题、没看过正文的条款,
		//     而那正是本项目取证纪律要拦的事(agent 路径的 system.md:12 写的是同一条规矩)。
		// 不变量:**渲染进 prompt 的集合 === clauseIds 集合**,两者必须由同一个 items 派生。
		const clauseIds = items.map((item) => item.clause_id);
		const byId = new Map(merged.map((hit) => [hit.clause_id, hit]));

		const answerText = await promptOnce(`${fp.answerPrompt}\n\n${renderEvidence(items, byId)}`);
		// abort 在 pi 里不是粘滞状态(见 final-judge.ts 里 runFinalJudges 对这件事的说明),
		// 超时后 prompt() 可能正常返回一段被截断的文本 —— 必须自己复查一次,否则半截答案会被
		// 当成合格结果收下。
		if (isTimedOut()) {
			const reason = `阶段 1 超时(${fp.limits.runTimeoutMs}ms)`;
			emit("fast_path_escalated", { reason });
			return { verdict: { accept: false, reason }, result: normalize(runId, startedAt, answerText) };
		}
		// 判官读的、与最终交给调用方的 `RunResult.output`,必须是**同一段**文本:两者都来自
		// `promptOnce` 的返回值(`session.getLastAssistantText()`),这里的 `answerText` 就是
		// 那份返回值,原样传给 `judgeFastPathOutput` 与 `normalize`,不重新读取一次 ——
		// 重新读取会有极小的窗口读到助手消息被后续事件(比如下一次 prompt)覆盖后的状态。
		const verdict = judgeFastPathOutput(answerText, options.outputContractSchema, clauseIds);
		if (!verdict.accept) emit("fast_path_escalated", { reason: verdict.reason });
		return { verdict, result: normalize(runId, startedAt, answerText) };
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
