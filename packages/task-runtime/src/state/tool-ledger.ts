import { randomUUID } from "node:crypto";
import { hashState } from "./json.ts";
import type { StateStore } from "./store.ts";

export type ToolEffect = "read" | "idempotent_write" | "non_idempotent_write";
export interface ToolOperation {
	onReplay?: () => void;
	scope: string;
	runId: string;
	callId: string;
	tool: string;
	toolVersion?: string;
	effect: ToolEffect;
	args: Record<string, unknown>;
	signal?: AbortSignal;
}
interface OperationState {
	version: 1;
	fingerprint: string;
	owner: string;
	status: "running" | "completed" | "failed" | "unknown";
	leaseUntil: number;
	result?: unknown;
}

export class ToolLedger {
	private readonly store: StateStore;
	private readonly now: () => number;
	private readonly leaseMs: number;
	constructor(store: StateStore, options: { now?: () => number; leaseMs?: number } = {}) {
		this.store = store;
		this.now = options.now ?? Date.now;
		this.leaseMs = options.leaseMs ?? 60000;
		if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) throw new Error("leaseMs must be positive");
	}
	async execute(
		request: ToolOperation,
		invoke: (context: { idempotencyKey: string }) => Promise<unknown>,
	): Promise<unknown> {
		if (!["read", "idempotent_write", "non_idempotent_write"].includes(request.effect))
			throw new Error("tool_effect_required");
		for (const value of [request.scope, request.runId, request.callId, request.tool])
			if (!value) throw new Error("tool operation identity is required");
		request.signal?.throwIfAborted();
		const key = canonicalKey(request);
		const fingerprint = hashState({
			scope: request.scope,
			tool: request.tool,
			toolVersion: request.toolVersion ?? "unversioned",
			effect: request.effect,
			args: request.args,
		});
		const previous = await this.store.get(key);
		if (previous) {
			const state = previous.value as OperationState;
			if (
				state?.version !== 1 ||
				state.fingerprint !== fingerprint ||
				!["running", "completed", "failed", "unknown"].includes(state.status) ||
				!Number.isFinite(state.leaseUntil)
			)
				throw new Error("tool_idempotency_conflict");
			if (state.status === "completed") {
				request.onReplay?.();
				return state.result;
			}
			if (state.status === "unknown") throw new Error("tool_outcome_unknown");
			if (state.status === "running" && state.leaseUntil > this.now()) throw new Error("tool_in_progress");
			if (state.status === "running" && request.effect === "non_idempotent_write") {
				await this.store.compareAndSwap(key, previous.revision, { ...state, status: "unknown" });
				throw new Error("tool_outcome_unknown");
			}
		}
		const state: OperationState = {
			version: 1,
			fingerprint,
			owner: randomUUID(),
			status: "running",
			leaseUntil: this.now() + this.leaseMs,
		};
		if (!(await this.store.compareAndSwap(key, previous?.revision ?? null, state)))
			throw new Error("tool_in_progress");
		const revision = (previous?.revision ?? 0) + 1;
		let invoked = false;
		try {
			request.signal?.throwIfAborted();
			invoked = true;
			const result = await invoke({ idempotencyKey: hashState([request.scope, request.runId, request.callId]) });
			if (!(await this.store.compareAndSwap(key, revision, { ...state, status: "completed", result })))
				throw new Error("tool_ownership_lost");
			return result;
		} catch (error) {
			try {
				await this.store.compareAndSwap(key, revision, {
					...state,
					leaseUntil: 0,
					status: invoked && request.effect === "non_idempotent_write" ? "unknown" : "failed",
				});
			} catch (storeError) {
				throw new AggregateError([error, storeError], "tool execution and state persistence failed");
			}
			throw error;
		}
	}
}

function canonicalKey(request: ToolOperation): string {
	return JSON.stringify(["tool", request.scope, request.runId, request.callId]);
}
