import { randomUUID } from "node:crypto";
import { type Assembled, type AssembleOptions, assemble } from "./assembler.ts";
import type { LimitKind, RunOptions, RunResult, Runtime, RuntimeEvent } from "./contract.ts";
import { createLimitsDescriptor, LIMITS_PLUGIN_NAME, type LimitState } from "./plugins/limits.ts";

export type CreateSessionRuntimeOptions = Omit<AssembleOptions, "builtinPlugins">;

export async function createSessionRuntime(options: CreateSessionRuntimeOptions): Promise<Runtime> {
	const state: LimitState = { turns: 0 };
	let abortFn: () => void = () => {};
	// `assemble()` hasn't run yet when the limits descriptor is registered below, but the
	// descriptor's `getStats` closure is only ever invoked from a `turn_end` hook -- i.e.
	// after `assemble()` has resolved and assigned this. Declared with `let ...!:` (definite
	// assignment assertion) rather than reading `assembled` from the outer `const` declared
	// further down: referencing that later `const` from here would trip TS2448 ("used before
	// its declaration"), since the closure and the declaration live in the same function scope.
	let assembled!: Assembled;

	options.registry.register(
		createLimitsDescriptor(state, {
			limits: options.spec.limits,
			getStats: () => {
				const stats = assembled.session.getSessionStats();
				return { totalTokens: stats.tokens.total, cost: stats.cost };
			},
			abort: () => abortFn(),
		}),
	);

	assembled = await assemble({ ...options, builtinPlugins: [LIMITS_PLUGIN_NAME] });
	const session = assembled.session;
	abortFn = () => void session.abort();

	const id = randomUUID();
	const specId = assembled.specId;
	let seq = 0;
	let currentRunId = "";
	let lastActiveAt = Date.now();
	const listeners = new Set<(event: RuntimeEvent) => void>();

	const unsubscribeSession = session.subscribe((event) => {
		lastActiveAt = Date.now();
		const enveloped: RuntimeEvent = {
			runId: currentRunId,
			specId,
			seq: seq++,
			ts: Date.now(),
			type: event.type,
			payload: event,
		};
		for (const listener of listeners) listener(enveloped);
	});

	async function run(input: string, opts?: RunOptions): Promise<RunResult> {
		const runId = opts?.runId ?? randomUUID();
		currentRunId = runId;
		// Reset per-run: without this, a second run() on the same Runtime would inherit the
		// previous run's turn count / tripped limit and could trip immediately.
		state.turns = 0;
		state.tripped = undefined;
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
		try {
			await session.prompt(input);
		} catch (error) {
			thrown = error;
		} finally {
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
			status: classify(state.tripped, assistant?.stopReason, thrown),
			output: session.getLastAssistantText() ?? undefined,
			errorMessage: thrown instanceof Error ? thrown.message : assistant?.errorMessage,
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
		steer: async (text: string) => void session.steer(text),
		followUp: async (text: string) => void session.followUp(text),
		abort: async () => void session.abort(),
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
