import { randomUUID } from "node:crypto";
import { type Assembled, type AssembleOptions, assemble } from "./assembler.ts";
import type { LimitKind, LimitState, RunOptions, RunResult, Runtime, RuntimeEvent } from "./contract.ts";
import { collectClauseIds, type FinalJudge, runFinalJudges } from "./final-judge.ts";
import type { PluginContext } from "./plugin-registry.ts";

export type CreateSessionRuntimeOptions = Omit<AssembleOptions, "pluginContext">;

export async function createSessionRuntime(options: CreateSessionRuntimeOptions): Promise<Runtime> {
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
	};

	assembled = await assemble({ ...options, pluginContext });
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
		if (event.type === "tool_execution_end") {
			collectClauseIds((event as { result?: unknown }).result, clauseIds);
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
					// 判官自身抛(比如 assess 的 MCP 调用失败)不该把整个 run 变成静默成功。
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
			status: judgeError ? ("error" as const) : classify(state.tripped, assistant?.stopReason, thrown),
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

function classify(tripped: LimitKind | undefined, stopReason: string | undefined, thrown: unknown) {
	if (tripped) return "limit_exceeded" as const;
	if (thrown) return "error" as const;
	if (stopReason === "aborted") return "aborted" as const;
	if (stopReason && stopReason !== "stop") return "error" as const;
	return "completed" as const;
}
