import { randomUUID } from "node:crypto";
import { authorize, type Grant, grantScopeHash } from "../auth/grant.ts";
import type { MemoryScope } from "../memory/service.ts";
import { hashState } from "../state/json.ts";
import type { StateStore } from "../state/store.ts";

export interface Conversation {
	version: 1;
	messages: unknown[];
	scopeHash: string;
	memoryRefs: Array<{ scope: MemoryScope; id: string; revision: number }>;
}
export interface MessageInput {
	clientMessageId: string;
	kind: "steer" | "follow_up";
	targetRunId?: string;
	afterRunId?: string;
	text: string;
}
export interface InboxMessage extends MessageInput {
	executionRoot?: string;
	messageId: string;
	sequence: number;
	status: "queued" | "dispatching" | "scheduled" | "consumed" | "blocked";
	grant: Grant;
	fingerprint: string;
	createdAt: number;
	consumedCheckpointSeq?: number;
	error?: string;
	runId?: string;
	owner?: string;
	leaseUntil?: number;
	conversation?: Conversation;
}
interface SessionState {
	version: 1;
	grant: Grant;
	nextSequence: number;
	active?: { runId: string; rootRunId: string; accepting: boolean };
	last?: { runId: string; status: string };
	conversation?: Conversation;
	messages: InboxMessage[];
	staged?: { runId: string; conversation: Conversation };
}
/** CAS protects message acceptance against run sealing; the inbox is the durable queue. */
export class SessionInbox {
	readonly store: StateStore;
	constructor(store: StateStore) {
		this.store = store;
	}
	private key(grant: Grant): string {
		return JSON.stringify(["inbox", grant.tenantId, grant.sub, grant.sessionId]);
	}
	private async mutate<T>(grant: Grant, fn: (state: SessionState) => T): Promise<T> {
		const key = this.key(grant);
		for (let attempt = 0; attempt < 16; attempt++) {
			const rec = await this.store.get(key);
			const state = rec?.value as SessionState | undefined;
			if (state && state.version !== 1) throw new Error("inbox_version_invalid");
			const value: SessionState = state ?? { version: 1, grant, nextSequence: 1, messages: [] };
			const result = fn(value);
			if (await this.store.compareAndSwap(key, rec?.revision ?? null, value)) return result;
		}
		throw new Error("inbox_busy");
	}
	async state(grant: Grant): Promise<SessionState | undefined> {
		return (await this.store.get(this.key(grant)))?.value as SessionState | undefined;
	}
	async begin(grant: Grant, runId: string, rootRunId: string, replaceRunId?: string): Promise<void> {
		await this.mutate(grant, (state) => {
			if (state.active && state.active.runId !== runId && state.active.runId !== replaceRunId)
				throw new Error("session_busy");
			state.grant = grant;
			state.active = { runId, rootRunId, accepting: true };
		});
	}
	async enqueue(grant: Grant, input: MessageInput): Promise<InboxMessage> {
		authorize(grant, input.kind === "steer" ? "run:steer" : "run:follow_up", { sessionId: grant.sessionId });
		if (
			!input.clientMessageId ||
			input.clientMessageId.length > 256 ||
			!input.text?.trim() ||
			input.text.length > 8000 ||
			!["steer", "follow_up"].includes(input.kind) ||
			(input.kind === "steer"
				? !input.targetRunId || input.afterRunId !== undefined
				: !input.afterRunId || input.targetRunId !== undefined)
		)
			throw new Error("message_invalid");
		const fingerprint = hashState({ ...input, scope: grantScopeHash(grant) });
		return this.mutate(grant, (state) => {
			const old = state.messages.find((m) => m.clientMessageId === input.clientMessageId);
			if (old) {
				if (old.fingerprint !== fingerprint) throw new Error("message_conflict");
				return old;
			}
			if (
				state.messages.length >= 1000 ||
				state.messages.filter((m) => ["queued", "dispatching"].includes(m.status)).length >= 64
			)
				throw new Error("message_queue_full");
			if (
				input.kind === "steer" &&
				(!state.active?.accepting || ![state.active.runId, state.active.rootRunId].includes(input.targetRunId!))
			)
				throw new Error("run_not_active");
			if (input.kind === "follow_up" && ![state.active?.runId, state.last?.runId].includes(input.afterRunId))
				throw new Error("run_not_found");
			const message: InboxMessage = {
				...input,
				...(input.kind === "steer" ? { executionRoot: state.active!.rootRunId } : {}),
				messageId: randomUUID(),
				sequence: state.nextSequence++,
				status: "queued",
				grant,
				fingerprint,
				createdAt: Date.now(),
			};
			state.messages.push(message);
			return message;
		});
	}
	async messages(grant: Grant): Promise<InboxMessage[]> {
		return (await this.state(grant))?.messages ?? [];
	}
	async pendingSteers(grant: Grant, rootRunId: string, consumed: string[]): Promise<InboxMessage[]> {
		return this.mutate(grant, (state) => {
			if (!state.active || state.active.rootRunId !== rootRunId) throw new Error("inbox_owner_mismatch");
			return state.messages.filter((m) => {
				if (
					m.kind !== "steer" ||
					m.status !== "queued" ||
					(m.executionRoot ?? m.targetRunId) !== rootRunId ||
					consumed.includes(m.messageId)
				)
					return false;
				if (m.grant.exp * 1000 <= Date.now() || grantScopeHash(m.grant) !== grantScopeHash(grant)) {
					m.status = "blocked";
					m.error = "message_authorization_expired_or_changed";
					return false;
				}
				return true;
			});
		});
	}
	async acknowledge(grant: Grant, rootRunId: string, ids: string[], checkpointSeq: number): Promise<void> {
		await this.mutate(grant, (state) => {
			if (!state.active || state.active.rootRunId !== rootRunId) throw new Error("inbox_owner_mismatch");
			for (const m of state.messages)
				if (ids.includes(m.messageId) && ["queued", "dispatching", "scheduled"].includes(m.status)) {
					m.status = "consumed";
					m.consumedCheckpointSeq = checkpointSeq;
				}
		});
	}
	async seal(grant: Grant, rootRunId: string, stop = false): Promise<boolean> {
		return this.mutate(grant, (state) => {
			if (!state.active || state.active.rootRunId !== rootRunId) throw new Error("inbox_owner_mismatch");
			const pending = state.messages.filter(
				(m) => m.kind === "steer" && m.status === "queued" && (m.executionRoot ?? m.targetRunId) === rootRunId,
			);
			if (pending.length && !stop) return false;
			for (const m of pending) {
				m.status = "blocked";
				m.error = "run_stopped_before_consumption";
			}
			state.active.accepting = false;
			return true;
		});
	}
	async finish(grant: Grant, runId: string, status: string, conversation?: Conversation): Promise<void> {
		await this.mutate(grant, (state) => {
			if (state.active?.runId !== runId) return;
			const rootRunId = state.active.rootRunId;
			state.last = { runId, status };
			delete state.active;
			conversation ??=
				status === "completed" && state.staged?.runId === runId ? state.staged.conversation : undefined;
			delete state.staged;
			if (conversation) {
				if (Buffer.byteLength(JSON.stringify(conversation)) > 2 * 1024 * 1024)
					throw new Error("conversation_too_large");
				state.conversation = conversation;
			}
			for (const m of state.messages)
				if (
					status !== "error" &&
					m.kind === "steer" &&
					m.status === "queued" &&
					(m.executionRoot ?? m.targetRunId) === rootRunId
				) {
					m.status = "blocked";
					m.error = "run_stopped_before_consumption";
				}
		});
	}
	async pause(grant: Grant, rootRunId: string): Promise<void> {
		await this.mutate(grant, (state) => {
			if (!state.active || state.active.rootRunId !== rootRunId) throw new Error("inbox_owner_mismatch");
			state.active.accepting = false;
		});
	}
	async stageConversation(grant: Grant, runId: string, conversation: Conversation): Promise<void> {
		if (Buffer.byteLength(JSON.stringify(conversation)) > 2 * 1024 * 1024) throw new Error("conversation_too_large");
		await this.mutate(grant, (state) => {
			if (state.active?.runId !== runId) throw new Error("inbox_owner_mismatch");
			state.staged = { runId, conversation };
		});
	}
	async scan(after = ""): Promise<Array<{ key: string; grant: Grant }>> {
		if (!this.store.scan) throw new Error("inbox_scan_required");
		return (await this.store.scan('["inbox",', after, 100)).map((row) => ({
			key: row.key,
			grant: (row.value as SessionState).grant,
		}));
	}
	async claimFollowUp(grant: Grant, owner: string): Promise<InboxMessage | undefined> {
		return this.mutate(grant, (state) => {
			if (state.active) return;
			const first = state.messages.find(
				(m) => m.kind === "follow_up" && (m.status === "queued" || m.status === "dispatching"),
			);
			if (!first || (first.status === "dispatching" && (first.leaseUntil ?? 0) > Date.now())) return;
			if (first.grant.exp * 1000 <= Date.now()) {
				first.status = "blocked";
				first.error = "authorization_expired";
				return;
			}
			if (state.last?.status !== "completed" || !state.conversation) {
				first.status = "blocked";
				first.error = "predecessor_not_completed";
				return;
			}
			if (state.conversation.scopeHash !== grantScopeHash(first.grant)) {
				first.status = "blocked";
				first.error = "conversation_authorization_changed";
				return;
			}
			first.status = "dispatching";
			first.owner = owner;
			first.leaseUntil = Date.now() + 60000;
			first.conversation ??= state.conversation;
			return first;
		});
	}
	async dispatched(grant: Grant, id: string, owner: string, runId?: string, error?: string): Promise<void> {
		await this.mutate(grant, (state) => {
			const m = state.messages.find((m) => m.messageId === id);
			if (!m || m.owner !== owner || !["dispatching", "consumed"].includes(m.status))
				throw new Error("message_ownership_lost");
			if (runId) {
				m.runId = runId;
				if (m.status !== "consumed") m.status = "scheduled";
			} else if (error === "queue_full" || error === "session_busy") {
				m.status = "queued";
			} else {
				m.status = "blocked";
				m.error = error ?? "dispatch_failed";
			}
			delete m.owner;
			delete m.leaseUntil;
			delete m.conversation;
		});
	}
}
