import { randomUUID } from "node:crypto";
import { type Assembled, type AssembleOptions, assemble } from "./assembler.ts";
import type { LimitKind, LimitState, RunOptions, RunResult, Runtime, RuntimeEvent } from "./contract.ts";
import { collectClauseIds, type FinalJudge, runFinalJudges } from "./final-judge.ts";
import { createOutputContractJudge } from "./output-contract.ts";
import type { PluginContext } from "./plugin-registry.ts";

export type CreateSessionRuntimeOptions = Omit<AssembleOptions, "pluginContext"> & {
	/** spec.outputContract.schema 指向的文件已由调用方读好。缺省即不挂 C6 判官。 */
	outputContractSchema?: unknown;
};

export async function createSessionRuntime(options: CreateSessionRuntimeOptions): Promise<Runtime> {
	// 装配期失败要早要响(这是全仓的一贯纪律,assemble() 里的 validateSpec / 工具名交叉校验
	// 都是这条纪律的例子):spec 声明了 outputContract 却没有配套的 outputContractSchema,
	// 说明某个调用点忘了把 schema 文件读进来传下来(cli/main.ts 曾经就是这样,只有
	// server/main.ts 接了线)——不能让 C6 因此悄悄不挂,那是这个"把静默错误变成响亮失败"
	// 的判官最不该有的失效姿态。审查 Important-2:此前这里只是把它当空判官悄悄跳过。
	if (options.spec.outputContract !== undefined && options.outputContractSchema === undefined) {
		throw new Error(
			`RuntimeSpec "${options.spec.id}": outputContract is declared but outputContractSchema was not supplied to createSessionRuntime`,
		);
	}
	const state: LimitState = { turns: 0 };
	let abortFn: () => void = () => {};
	// `assemble()` hasn't run yet when `pluginContext` is built below, but its `getSession`
	// handle is only ever invoked from a hook -- i.e. after `assemble()` has resolved and
	// assigned this. Declared with `let ...!:` (definite assignment assertion) rather than
	// reading `assembled` from the outer `const` declared further down: referencing that later
	// `const` from here would trip TS2448 ("used before its declaration"), since the closure
	// and the declaration live in the same function scope.
	let assembled!: Assembled;
	let currentRunId = "";
	let currentRunInput = "";

	// 终局判官表 + 本 run 见过的 clause_id。两者都由下面的 pluginContext / session.subscribe
	// 填,由 run() 末尾的 runFinalJudges 消费。judges 是**装配期**填一次(插件工厂里登记),
	// clauseIds 每次 run() 开头清空。
	const judges: FinalJudge[] = [];
	const clauseIds = new Set<string>();

	// limits 不在这里构造描述符了:它是 createDefaultPluginRegistry() 里的进程级描述符,
	// 由 assemble() 从 options.registry 无条件 lookup 出来。本次 run 的状态(LimitState、
	// abort 句柄)全部经下面这个 PluginContext 注入 —— 所以一个 PluginRegistry 可以被
	// 反复复用,也不会在并发 run 之间串状态。见 plugin-registry.ts 的类注释。
	const pluginContext: PluginContext = {
		specId: options.spec.id,
		getRunId: () => currentRunId,
		getSession: () => assembled.session,
		abort: () => abortFn(),
		limitState: state,
		registerFinalJudge: (judge) => judges.push(judge),
		getRunInput: () => currentRunInput,
	};

	assembled = await assemble({ ...options, pluginContext });
	// **最后**追加 C6:判官按登记顺序跑,插件登记的(C3)排在前面 —— 证据不足时先补证据,
	// 没必要先修 JSON 格式。C6 必须在插件登记完(assemble() 内部发生)之后才推进 judges,
	// 所以放在这里而不是 pluginContext 声明的地方。
	const contractSchema = options.outputContractSchema;
	const outputContractJudge =
		contractSchema === undefined || options.spec.outputContract === undefined
			? undefined
			: createOutputContractJudge({
					schema: contractSchema,
					maxRepairAttempts: options.spec.outputContract.maxRepairAttempts ?? 2,
				});
	if (outputContractJudge) judges.push(outputContractJudge);
	const session = assembled.session;
	// abortFn is invoked from two synchronous callbacks -- the limits plugin's `turn_end`
	// hook and the runTimeoutMs setTimeout below -- neither of which can be made to `await`
	// this. session.abort() is async and can reject; left unhandled that becomes an
	// unhandled promise rejection, which modern Node treats as fatal (crashes the process).
	// This path is best-effort cleanup, not the public Runtime.abort() contract (see below),
	// so a failed abort here is swallowed after logging rather than propagated.
	abortFn = () => {
		void session.abort().catch((error: unknown) => {
			// `specId` is a `const` declared further down this function -- referencing it here
			// (rather than `assembled.specId`, which is already assigned by this point) would
			// hit the same TS2448 "used before its declaration" issue documented on `assembled` above.
			console.error(
				`[SessionRuntime] abort() triggered by a limit/timeout failed for spec "${assembled.specId}"`,
				error,
			);
		});
	};

	const id = randomUUID();
	const specId = assembled.specId;
	let seq = 0;
	let lastActiveAt = Date.now();
	const listeners = new Set<(event: RuntimeEvent) => void>();

	const unsubscribeSession = session.subscribe((event) => {
		lastActiveAt = Date.now();
		// 这里解码的是 pi 的 ToolExecutionEndEvent(types.ts:779-785 的 result 字段)。
		// 与 reconcile.ts 同一类耦合(风险 10):上游改字段名会让 clauseIds 静默变空。
		// 兜底不在这里 —— C6 的反幻觉校验会在 basis 非空而 clauseIds 空时判失败,
		// 把静默错误变成响亮的契约校验失败。
		//
		// isError:true 的结果不采(C3 语义决策,Task 7 记档、Task 9 到期处理):pi 的
		// AgentTool 契约是"失败就 throw,不要把错误编进 content"(agent/src/types.ts 对
		// AgentTool.execute 的文档字符串),**本仓当前**唯一产出通路是 agent-loop.ts 的
		// createErrorToolResult(...),它合成的 result 固定是
		// `{ content: [{ type: "text", text: message }], details: {} }`——message 并非任意文本:
		// packages/task-runtime/src/toolsets/mcp/adapter.ts 在 MCP 工具返回业务级 isError:true 时
		// `throw new Error(result.text)`,而 mcp/client.ts 的 callTool() 对业务级错误(而非协议/
		// 传输层错误)把 `result.text` 设成 MCP server 原样返回的 content 拼接文本、不加任何前缀
		// (`MCP tool "x" failed: ...` 前缀只在协议层 catch 分支里加,业务级分支没有)—— 于是一个
		// "clause_id 查了但没找到"的错误结果,只要 server 端把查询到的 clause_id 回显在这段文本里
		// (常见错误响应形态),就会被 tryParseJson 解析出来、当成"已检索到"计入 clauseIds。这会让
		// C3(充分性判定)把一次失败的查询算作覆盖,也会让 C6 的反幻觉校验错误地认可一个从未真正
		// 取到内容、只在错误回显里出现过的 clause_id。过滤 isError:true 让 clauseIds 只承载"确实
		// 执行成功的工具结果",这对 C3/C6 是同一个方向的收紧,不是两个互相冲突的诉求。
		//
		// **已知的例外通路,机制上可达**:pi 允许一个声明了 `tool_result` 这个替换型 hook
		// (见 plugin-registry.ts 的 REPLACING_HOOKS)的扩展把 isError 反过来翻成 true 而
		// content 保留原本成功的内容(coding-agent/agent-session.ts 的 hook 派发 + agent-loop.ts
		// 的落地点;`tool_result` hook 的返回值类型文档明写"if provided, replaces the tool
		// result error flag")。这条过滤没有对这种情形做任何特殊处理 —— 若真的发生,会把一次
		// 本来成功、真正取到内容的结果误判成"不予采信"。**plugins/result-budget.ts 落地后,
		// 「现存插件均未声明 tool_result」这一前提已不成立**——它就挂在 tool_result 上,只做
		// 长度 / 命中条数截断,`isError` 原样回填、不翻转(见该文件对 details/isError/usage
		// 三个字段的显式带回),所以不构成这条通路的实例。截至目前,声明了 hook 的插件只有
		// limits(挂 turn_end,观察型)与 result-budget(挂 tool_result 但不翻转 isError)
		// 两个,均不触发这条路径;若将来有插件借 tool_result 翻转 isError,需要同步复核这条
		// 过滤是否还站得住。
		//
		// try/catch 的理由与下面 listener fan-out 那圈**完全相同**,而且这里更靠前:这段代码
		// 同样跑在 pi 无 try/catch 的 AgentSession._emit 里,抛出去会直接穿透 agent loop 打死
		// 在跑的 run。result 是 AgentToolResult = { content, details },其中 details 是工具私有
		// 结构、不进 provider 请求、因此**不受"必须可序列化"约束**,装得下任意对象(含环)。
		// collectClauseIds 自身已有环检测与深度上限(两条都有各自的判别性测试),这圈是最后
		// 一道保险,由 session-runtime.test.ts 的
		// `keeps the run alive when collecting clause_ids throws inside pi's unprotected _emit` 锁住。
		//
		// 这圈保证的是「**不是我们这行**打死 agent loop」,不是「这种输入不会失败」——
		// 两者的差别正是那条测试的 fixture 要拿捏的地方,getter **只抛第一次**:我们的
		// subscriber 比 pi 先读到 details,第一次读由这圈吃掉。
		//
		// pi 后来那次读之所以安全,靠的是**时序**而不是"pi 不枚举 details":pi 会在组装下一轮
		// context 时用 structuredClone 深拷贝整个消息历史(含这个 details),那确实会枚举到同一个
		// getter —— 出处是 ExtensionRunner.emitContext(coding-agent/src/core/extensions/runner.ts:981),
		// 经 sdk.ts:353 transformContext ← agent-loop.ts:291 streamAssistantResponse。但它必然发生在
		// 本轮 tool_execution_end **之后**(下一轮 context 组装前必须先把本轮工具结果记入消息历史),
		// 所以轮到 pi 读时 one-shot 已经用掉了。正常态实测 getter 被读 2 次,两次的调用栈正是上面
		// 这两条路径。
		//
		// 换成恒抛的 getter 就没有判别性了 —— 那种输入无论有没有这圈都以 error 收场,因为上面那次
		// structuredClone 照样会撞上它。
		if (event.type === "tool_execution_end" && !event.isError) {
			try {
				collectClauseIds(event.result, clauseIds);
			} catch (error) {
				console.error(
					`[SessionRuntime] collectClauseIds threw for spec "${specId}"; this run's clauseIds may be incomplete`,
					error,
				);
			}
		}
		const enveloped: RuntimeEvent = {
			runId: currentRunId,
			specId,
			seq: seq++,
			ts: Date.now(),
			type: event.type,
			payload: event,
		};
		// This fan-out runs synchronously inside pi's AgentSession._emit (agent-session.ts),
		// which has no try/catch of its own -- an uncaught throw from any listener would
		// unwind straight through the agent loop and kill the in-flight run. subscribe() is
		// a public contract and the entry point for S2's event pipeline, so a single bad
		// consumer must not be able to take the session down (the first in-tree consumer,
		// trajectory.ts, already calls JSON.stringify(event), which throws on a cyclic
		// payload). Log and keep fanning out to the remaining listeners.
		for (const listener of listeners) {
			try {
				listener(enveloped);
			} catch (error) {
				console.error(
					`[SessionRuntime] event subscriber threw for spec "${specId}" event "${enveloped.type}"; continuing fan-out`,
					error,
				);
			}
		}
	});

	async function run(input: string, opts?: RunOptions): Promise<RunResult> {
		const runId = opts?.runId ?? randomUUID();
		currentRunId = runId;
		currentRunInput = input;
		// Reset per-run: without this, a second run() on the same Runtime would inherit the
		// previous run's turn count / tripped limit and could trip immediately.
		state.turns = 0;
		state.tripped = undefined;
		clauseIds.clear();
		const startedAt = Date.now();

		// runTimeoutMs lives here, not in the limits plugin: the plugin only observes
		// turn_end, so it can never notice a timeout mid-turn. Both write the same
		// LimitState.tripped so RunResult.limit has a single source of truth.
		let timer: NodeJS.Timeout | undefined;
		if (options.spec.limits.runTimeoutMs !== undefined) {
			timer = setTimeout(() => {
				if (state.tripped) return;
				state.tripped = "runTimeout";
				abortFn();
			}, options.spec.limits.runTimeoutMs);
		}

		let thrown: unknown;
		let judgeError: string | undefined;
		try {
			try {
				await session.prompt(input);
			} catch (error) {
				thrown = error;
			}

			// 终局重判:prompt() 返回 = pi 的循环已经停(无更多工具调用、无排队消息),
			// 正是规格 §3.1 想要的 isFinalTurn 时点。
			// thrown !== undefined 时不进重判:prompt 本身就炸了,再发一次只会拿到第二次爆炸。
			if (thrown === undefined && judges.length > 0) {
				const outcome = await runFinalJudges({
					judges,
					getLastAssistantText: () => session.getLastAssistantText() ?? "",
					getClauseIds: () => [...clauseIds],
					reprompt: async (text) => {
						await session.prompt(text);
					},
					// state.turns / timer 都不重置 —— maxTurns 与 runTimeoutMs 横跨全部重判,
					// 这是重判不会变成无限循环的第二道保险(第一道是 Σ maxAttempts)。
					shouldStop: () => state.tripped !== undefined,
				}).catch((error: unknown) => {
					// 最后一道网。判官抛与 reprompt 抛都已经在 runFinalJudges 内部就地转成了
					// errorMessage(那里能保住已花掉的 attempts),所以这圈只可能被上面这几个
					// deps 闭包自己抛出的异常触发 —— 那种情况下确实没有 attempts 可报。
					// 无论如何都不能让它变成静默成功。
					return { attempts: {}, errorMessage: error instanceof Error ? error.message : String(error) };
				});
				judgeError = outcome.errorMessage;
			}
		} finally {
			// clearTimeout 挪到重判**之后**(brief 把它留在第一层 finally 里):留在原处的话,
			// runTimeout 的定时器会在第一次 prompt() 返回时就被清掉,上面那句"runTimeoutMs
			// 横跨全部重判"便是空话 —— 重判还能再发 Σ maxAttempts 次 prompt,足以把一个声明了
			// 5s 上限的 run 拖到任意长。让定时器活到重判结束,runTimeout 才真的是整个 run
			// (含重判)的挂钟硬顶,shouldStop() 也才能在重判途中读到 tripped="runTimeout"。
			if (timer) clearTimeout(timer);
		}

		lastActiveAt = Date.now();
		const stats = session.getSessionStats();
		const assistant = session.messages
			.slice()
			.reverse()
			.find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;

		return {
			runId,
			specId,
			status: classify(state.tripped, assistant?.stopReason, thrown, judgeError),
			output: session.getLastAssistantText() ?? undefined,
			errorMessage: judgeError ?? (thrown instanceof Error ? thrown.message : assistant?.errorMessage),
			stopReason: assistant?.stopReason,
			limit: state.tripped,
			usage: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				total: stats.tokens.total,
				cost: stats.cost,
			},
			turns: state.turns,
			durationMs: Date.now() - startedAt,
		};
	}

	return {
		id,
		specId,
		sessionId: session.sessionId,
		run,
		// Return the underlying promise directly (not `void`-wrapped): callers `await` these
		// per the Runtime contract expecting the operation to have actually finished --
		// session.abort() in particular awaits waitForIdle() internally (agent-session.ts),
		// so swallowing that promise here would let `await runtime.abort()` resolve before
		// the session has actually stopped. A rejection here is a genuine caller-visible
		// failure (unlike abortFn's fire-and-forget cleanup path above), so it propagates.
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
			unsubscribeSession();
			listeners.clear();
			await assembled.dispose();
		},
	};
}

/**
 * judgeError 走 classify 而不是在调用点写 `judgeError ? "error" : classify(...)`:后者会把
 * classify 自己确立的优先级**反过来** —— limit 压倒 error 是这里的第一条分支。限额在判官轮内
 * 触发、同时某个 onExhausted:"error" 的判官耗尽(或判官抛异常)时,那种写法会产出
 * `status:"error"` 配 `limit:"runTimeout"` 这种自相矛盾的 RunResult,下游按
 * `status === "limit_exceeded"` 记预算超支的会直接漏记。C6 明确用 onExhausted:"error",
 * 这个分歧必然会遇上。
 */
function classify(
	tripped: LimitKind | undefined,
	stopReason: string | undefined,
	thrown: unknown,
	judgeError?: string,
) {
	if (tripped) return "limit_exceeded" as const;
	if (thrown || judgeError) return "error" as const;
	if (stopReason === "aborted") return "aborted" as const;
	if (stopReason && stopReason !== "stop") return "error" as const;
	return "completed" as const;
}
