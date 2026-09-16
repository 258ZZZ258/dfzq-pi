import { randomUUID } from "node:crypto";
import type { StateRecord, StateStore } from "./store.ts";

interface RunState {
	version: 1;
	fingerprint: string;
	owner: string;
	fence: number;
	leaseUntil: number;
	status: "running" | "paused" | "completed";
	checkpoint?: unknown;
	checkpointSeq: number;
}
export interface RunClaim {
	scope: string;
	runId: string;
	fingerprint: string;
}

export class CheckpointCoordinator {
	readonly store: StateStore;
	readonly now: () => number;
	readonly leaseMs: number;
	constructor(store: StateStore, options: { now?: () => number; leaseMs?: number } = {}) {
		this.store = store;
		this.now = options.now ?? Date.now;
		this.leaseMs = options.leaseMs ?? 60000;
		if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) throw new Error("leaseMs must be positive");
	}
	async acquire(claim: RunClaim): Promise<CheckpointLease> {
		if (!claim.scope || !claim.runId || !claim.fingerprint) throw new Error("checkpoint identity required");
		const key = JSON.stringify(["checkpoint", claim.scope, claim.runId]);
		const previous = await this.store.get(key);
		const prior = previous?.value as RunState | undefined;
		if (prior && (prior.version !== 1 || prior.fingerprint !== claim.fingerprint || !Number.isInteger(prior.fence)))
			throw new Error("checkpoint_incompatible");
		if (prior?.status === "completed") throw new Error("task_already_completed");
		if (prior?.status === "running" && prior.leaseUntil > this.now()) throw new Error("task_in_progress");
		const state: RunState = {
			version: 1,
			fingerprint: claim.fingerprint,
			owner: randomUUID(),
			fence: (prior?.fence ?? 0) + 1,
			leaseUntil: this.now() + this.leaseMs,
			status: "running",
			checkpointSeq: prior?.checkpointSeq ?? 0,
			...(prior?.checkpoint === undefined ? {} : { checkpoint: prior.checkpoint }),
		};
		if (!(await this.store.compareAndSwap(key, previous?.revision ?? null, state)))
			throw new Error("task_in_progress");
		return new CheckpointLease(this, key, state);
	}
}

export class CheckpointLease {
	private readonly coordinator: CheckpointCoordinator;
	private readonly key: string;
	private readonly state: RunState;
	private pending: Promise<unknown> = Promise.resolve();
	readonly checkpoint: unknown;
	readonly fence: number;
	constructor(coordinator: CheckpointCoordinator, key: string, state: RunState) {
		this.coordinator = coordinator;
		this.key = key;
		this.state = state;
		this.checkpoint = state.checkpoint;
		this.fence = state.fence;
	}
	private async owned(): Promise<StateRecord & { value: RunState }> {
		const rec = await this.coordinator.store.get(this.key);
		const state = rec?.value as RunState | undefined;
		if (
			!rec ||
			!state ||
			state.owner !== this.state.owner ||
			state.fence !== this.fence ||
			state.status !== "running" ||
			state.leaseUntil <= this.coordinator.now()
		)
			throw new Error("task_ownership_lost");
		return { ...rec, value: state };
	}
	async assertOwned(): Promise<void> {
		await this.owned();
	}
	private mutate(change: (state: RunState) => RunState): Promise<void> {
		const next = this.pending
			.catch(() => {})
			.then(async () => {
				const rec = await this.owned();
				if (!(await this.coordinator.store.compareAndSwap(this.key, rec.revision, change(rec.value))))
					throw new Error("task_ownership_lost");
			});
		this.pending = next;
		return next;
	}
	renew(): Promise<void> {
		return this.mutate((state) => ({ ...state, leaseUntil: this.coordinator.now() + this.coordinator.leaseMs }));
	}
	async save(checkpoint: unknown): Promise<number> {
		let sequence = 0;
		await this.mutate((state) => {
			sequence = state.checkpointSeq + 1;
			return {
				...state,
				checkpoint,
				checkpointSeq: sequence,
				leaseUntil: this.coordinator.now() + this.coordinator.leaseMs,
			};
		});
		return sequence;
	}
	release(status: "paused" | "completed"): Promise<void> {
		return this.mutate((state) => ({ ...state, status, leaseUntil: 0 }));
	}
}
