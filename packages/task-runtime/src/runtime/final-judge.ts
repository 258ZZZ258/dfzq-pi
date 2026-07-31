export interface JudgeContext {
	lastAssistantText: string;
	/** 本 run 全部工具结果里出现过的 clause_id。C3 与 C6 共用同一份。 */
	clauseIds: readonly string[];
}

export type JudgeVerdict = { ok: true } | { ok: false; followUp: string; detail?: string };

export interface FinalJudge {
	name: string;
	/** 允许派发的 followUp 次数上限。 */
	maxAttempts: number;
	/** 次数用尽后仍不通过时怎么办。 */
	onExhausted: "pass" | "error";
	judge: (c: JudgeContext) => Promise<JudgeVerdict>;
}

export interface RejudgeDeps {
	judges: readonly FinalJudge[];
	getLastAssistantText: () => string;
	getClauseIds: () => readonly string[];
	reprompt: (text: string) => Promise<void>;
	/** 限额已触发 / 已 abort 时为 true —— 此时不得再发 prompt。 */
	shouldStop: () => boolean;
}

export interface RejudgeOutcome {
	attempts: Record<string, number>;
	/** 非空表示某个 onExhausted:"error" 的判官用尽了次数且仍不通过。 */
	errorMessage?: string;
}

/**
 * 终局重判。住在 SessionRuntime.run() 里,在 session.prompt() 返回之后、归一化
 * RunResult 之前跑。
 *
 * 不做成 hook 插件:pi 的循环在"无更多工具调用且无排队消息"时停,而 prompt() 返回
 * 恰好就是那一刻 —— 与规格 §3.1 里 `isFinalTurn(e)` 想表达的是同一个时点。做在这一层
 * 不依赖任何 hook 语义,C3(证据充分性)与 C6(输出契约)因此能共用同一台驱动器。
 *
 * 终止性:每轮循环要么派发一次 reprompt(总次数被 Σ maxAttempts 界住),要么直接返回。
 */
export async function runFinalJudges(deps: RejudgeDeps): Promise<RejudgeOutcome> {
	const attempts: Record<string, number> = {};
	for (const judge of deps.judges) attempts[judge.name] = 0;

	for (;;) {
		// 限额已触发就必须立刻收手。危害远不止"多跑一轮"—— 那次多发的 prompt 是**完全无界**的:
		//   1. abort 在 pi 里**不是粘滞状态**:packages/agent/src/agent.ts 的 abort() 只 abort
		//      当前 activeRun 的 AbortController,session 上不留任何 aborted 标记。新的
		//      session.prompt() 会开一个全新的 AbortController,正常跑起来。
		//   2. runTimeout 的 setTimeout 是**一次性**的(session-runtime.ts 的 run()),已经触发过
		//      就不会再触发第二次。
		//   3. limits 插件的 turn_end 钩子开头是 `if (state.tripped) return`(plugins/limits.ts),
		//      一旦置位就**永久**停止计数与 abort。
		// 三条叠起来:限额触发之后再发的这一次 prompt,既没有 turn 上限、也没有挂钟上限、
		// 更没有在途的 abort —— run() 会一直阻塞到模型自己停下来。
		if (deps.shouldStop()) return { attempts };

		const context: JudgeContext = {
			lastAssistantText: deps.getLastAssistantText(),
			clauseIds: deps.getClauseIds(),
		};

		let dispatched = false;
		for (const judge of deps.judges) {
			let verdict: JudgeVerdict;
			try {
				verdict = await judge.judge(context);
			} catch (error) {
				// 判官自身抛(比如 assess 的 MCP 调用失败)不该把整个 run 变成静默成功。就地转成
				// errorMessage 返回而不是让 promise reject:reject 会把已经花掉的 attempts 一起丢掉。
				// attempts 眼下**还没有消费方** —— RunResult 上没有这个字段,run 层只取
				// outcome.errorMessage,所以目前只有单测看得见它。保住它是为了让 RejudgeOutcome
				// 自身诚实(报告"重判了几次"是它的职责),要不要上到 RunResult 留给 C3/C6 定。
				return { attempts, errorMessage: `${judge.name}: ${describeError(error)}` };
			}
			if (verdict.ok) continue;

			if ((attempts[judge.name] ?? 0) >= judge.maxAttempts) {
				if (judge.onExhausted === "error") {
					return { attempts, errorMessage: `${judge.name}: ${verdict.detail ?? verdict.followUp}` };
				}
				continue; // pass:放过这个判官,继续看后面的
			}

			// 轮首那次 shouldStop() 与这里之间隔着一个 `await judge.judge(context)`,限额完全
			// 可能在那段 await 里翻 true —— 而 C3/C6 的判官要走 MCP assess 调用(秒级),
			// runTimeoutMs 恰好在判官 await 期间到期是常规结局,不是边角情况。少了这次复查,
			// 上面注释里那个"完全无界的 prompt"就会从这扇门进来。
			// 复查放在 attempts 自增**之前**:这一轮并没有真的花掉一次尝试,不该记账。
			if (deps.shouldStop()) return { attempts };

			attempts[judge.name] = (attempts[judge.name] ?? 0) + 1;
			try {
				await deps.reprompt(verdict.followUp);
			} catch (error) {
				// 同上:续跑失败也要保住已经花掉的 attempts。
				return { attempts, errorMessage: `${judge.name}: reprompt failed: ${describeError(error)}` };
			}
			dispatched = true;
			break; // 重跑**全部**判官 —— 补完证据后输出格式也可能变了
		}

		if (!dispatched) return { attempts };
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 粗略判断一段文本"看起来像"要被解析成 JSON——`tryParseJson` 与 `scanClauseIdsFallback`
 * 共用这道门槛,好让正则兜底只落在"本来是 JSON、只是解析失败"的文本上,不落在任意提到
 * clause_id 字样的自然语言备注上。 */
function looksLikeJson(trimmed: string): boolean {
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** 只有对象和数组才尝试解析,所以字符串不会递归成无穷。 */
function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!looksLikeJson(trimmed)) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/**
 * `tryParseJson` 解析失败时的正则兜底,只在 `JSON.parse` 抛错的字符串上跑,不改变任何
 * 已经能被结构化解析的路径。
 *
 * 动机(2026-07-31 审查发现的真实交互,不是假想场景):C4 result-budget 插件的 `maxChars`
 * 截断是对已序列化文本的一次原始 `slice`——如果截断点落在一段合法 JSON 的中间,产出的
 * 文本对 `JSON.parse` 是非法输入,但对模型**仍然可读**:`agent-loop.ts` 的
 * `finalizeExecutedToolCall`(:709-754)把 `tool_result` hook 的返回值写进
 * `finalized.result` 之后,**同一份** `finalized.result.content` 既喂给 `emitToolExecutionEnd`
 * (:763-771,本文件 `collectClauseIds` 的数据来源,经 session-runtime.ts 的
 * `tool_execution_end` 订阅)、也喂给 `createToolResultMessage`(:773-784,模型在下一轮
 * context 里读到的正是这份数据)。二者共享同一次截断,却只有模型那一侧对"半段 JSON"
 * 依然可读。
 *
 * 少了这条兜底,结构化解析分支会在截断点直接判"解析失败、这段内容一个 clause_id 都不采"——
 * 而模型可能已经从这段可读文本里看到一个完整的 `"clause_id":"A-1"` 并在 `basis` 里合法
 * 引用它。C6 的反幻觉校验(`output-contract.ts` 的 `checkConditional`)把"basis 非空而
 * clauseIds 空"判定为幻觉,于是一次真实检索、真实引用的回答被误判成编造 —— 方向是硬失败
 * 假阳性,比"漏采导致该通过的没通过"更糟。
 *
 * 要守住的不变量是"模型能读到的 clause_id,判官就必须能采到",不是"能解析出完整合法的
 * JSON"。直接在原始文本里正则找 `"clause_id":"..."` 子串,不管外层 JSON 结构是否完整,
 * 天然满足这条不变量:只要这段文本对模型可读(子串本身完整、有闭合引号),正则就能命中;
 * 如果截断恰好切在某个 clause_id 的值中间(比如 `"clause_id":"A-`),模型看到的也是一个
 * 不完整的值,两边同样一无所获,不构成新的不一致——`maxHits` 截断没有这个问题(截断后仍
 * `JSON.stringify` 成合法 JSON,被丢的 hits 模型也看不见,两边始终一致),只有 `maxChars`
 * 这种对已序列化文本做原始字符裁切的策略会制造"模型看得到、判官采不到"的单向缺口。
 *
 * 只在 `looksLikeJson` 为真时才扫:任意字符串值(比如工具结果里一段提到"参见
 * clause_id"字样的自然语言备注)都会走到这个函数,不加这道门槛会把正则的命中面从
 * "本来是 JSON、只是截断坏掉了"扩大到"任何提及这个子串的文本",引入与本次要修的问题
 * 无关的误报面。
 */
function scanClauseIdsFallback(text: string, out: Set<string>): void {
	if (!looksLikeJson(text.trim())) return;
	const pattern = /"clause_id"\s*:\s*"([^"]+)"/g;
	for (const match of text.matchAll(pattern)) {
		const id = match[1];
		if (id !== undefined && id.length > 0) out.add(id);
	}
}

/**
 * 从任意形状的工具结果里挖 clause_id。
 *
 * 形状不固定是有原因的:MCP 工具结果常见形态是 `content[].text` 里塞一段 JSON 字符串,
 * 而不同工具的数组字段名各不相同(hits / cases / items / rows)。与其枚举形状,不如
 * 全深度找 key —— 找不到时 C6 的反幻觉校验会替我们响亮失败(basis 非空而 clauseIds 空)。
 *
 * 字符串值解析失败时不是空手而归:见 `scanClauseIdsFallback` 的注释,这条正则兜底专门
 * 应对"JSON 被截断但对模型仍可读"的情形(C4 result-budget 的 `maxChars` 截断是已知会
 * 触发它的通路)。
 */
export function collectClauseIds(value: unknown, out: Set<string>): void {
	walk(value, out, new WeakSet<object>(), 0);
}

/**
 * 递归深度上限。真实形态里 clause_id 很浅(content[] → text 里的 JSON → hits[] → clause_id,
 * 大约 6 层),64 对合法数据是够不着的天花板,只用来兜住病态输入。
 */
const MAX_DEPTH = 64;

/**
 * 环检测(seen)与深度上限(depth)**两条都要**,少任何一条都堵不住 RangeError:
 *
 * - 只有深度上限:环 + 分叉会先炸在**指数级**上。一个节点带 5 个孩子且各自回指祖先时,
 *   深度 64 之内就有 5^64 条路径 —— 不抛栈溢出,但等价于挂死。
 * - 只有环检测:纯链状的超深结构(无环)一个节点都不重复,seen 永远不命中,照样栈溢出。
 *
 * seen 是 visited 而非 path 集合(进了不再退出):共享子树只走一次,顺带把 DAG 的重复展开
 * 也消掉。**一个已知的不精确**:两条防护会互相干扰 —— 若某节点的首次访问恰好落在
 * depth == MAX_DEPTH,它会被记进 seen 但其子节点在 depth+1 被截断;之后即使从更浅的路径
 * 再次到达它,也会被 seen 直接跳过,那棵子树的 id 就丢了。实测扫描 50–70 层的包裹深度,
 * 恰好 63 层复现一次。真实形态约 6 层够不着,且行为本就落在下面声明的"越界静默降级"里,
 * 所以不额外补偿(补偿要么记 (node, depth) 对、要么改成 path 集合,两者都会把 DAG 去重
 * 一起赔进去)。
 *
 * 越界时**静默降级**(该子树不再贡献 clause_id)而不是抛:这个函数跑在 pi 无 try/catch 的
 * _emit 里(见 session-runtime.ts 的调用点),抛出去会打死在跑的 run。漏采的后果由 C6 的
 * 反幻觉校验兜住 —— basis 非空而 clauseIds 空时判失败。
 */
function walk(value: unknown, out: Set<string>, seen: WeakSet<object>, depth: number): void {
	if (depth > MAX_DEPTH) return;

	if (typeof value === "string") {
		const parsed = tryParseJson(value);
		if (parsed !== undefined) {
			walk(parsed, out, seen, depth + 1);
			return;
		}
		// JSON.parse 失败(本来就不是 JSON,或是被截断成非法 JSON)—— 见 scanClauseIdsFallback
		// 的注释,这条正则兜底专门接住"模型仍读得到、结构化解析却接不住"的那部分。
		scanClauseIdsFallback(value, out);
		return;
	}
	if (typeof value !== "object" || value === null) return;

	// 环 / DAG 去重要在展开之前做,数组同样是对象,一并覆盖。
	if (seen.has(value)) return;
	seen.add(value);

	if (Array.isArray(value)) {
		for (const item of value) walk(item, out, seen, depth + 1);
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (key === "clause_id") {
			if (typeof nested === "string" && nested.length > 0) out.add(nested);
			continue;
		}
		walk(nested, out, seen, depth + 1);
	}
}
