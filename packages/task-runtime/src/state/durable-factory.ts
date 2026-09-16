import { randomUUID } from "node:crypto";
import { grantScopeHash } from "../auth/grant.ts";
import { GrantLease } from "../auth/lease.ts";
import { SessionInbox } from "../interaction/inbox.ts";
import type { SessionCheckpoint } from "../runtime/checkpoint.ts";
import type { Runtime, RuntimeEvent } from "../runtime/contract.ts";
import type { RuntimeFactory } from "../server/run-manager.ts";
import type { RunRecord } from "../store/contract.ts";
import type { CheckpointCoordinator, CheckpointLease } from "./checkpoints.ts";
import { hashState } from "./json.ts";

/** Claims are owned by the host, not the potentially blocked worker. */
export function withDurableExecution(
	factory: RuntimeFactory,
	coordinator: CheckpointCoordinator,
	configurationFingerprint: string,
): RuntimeFactory {
	if (!configurationFingerprint) throw new Error("configuration fingerprint required");
	const hostId = randomUUID();
	const activeRuns = new Set<string>();
	let closed = false;
	let hostWrites: Promise<void> = Promise.resolve();
	let hostHeartbeat: NodeJS.Timeout | undefined;
	const writeHost = () => {
		const next = hostWrites
			.catch(() => {})
			.then(async () => {
				const key = JSON.stringify(["host", hostId]);
				const previous = await coordinator.store.get(key);
				if (
					!(await coordinator.store.compareAndSwap(key, previous?.revision ?? null, {
						version: 1,
						leaseUntil: closed ? 0 : coordinator.now() + coordinator.leaseMs,
						activeRuns: [...activeRuns],
					}))
				)
					throw new Error("host_ownership_lost");
			});
		hostWrites = next;
		return next;
	};
	const wrapped: RuntimeFactory = async (input) => {
		const listeners = new Set<(event: RuntimeEvent) => void>();
		let sequence = 0;
		const fanOut = (event: RuntimeEvent) => {
			const normalized = { ...event, seq: sequence++ };
			for (const listener of listeners) {
				try {
					listener(normalized);
				} catch {}
			}
		};
		if (input.initialInput === undefined) throw new Error("durable execution requires initialInput");
		const rootRunId = input.options.resumeFrom ?? input.runId;
		const scope = hashState(JSON.parse(JSON.stringify({ sessionId: input.sessionId, filters: input.filters })));
		const { resumeFrom: _resumeFrom, authorization, ...otherOptions } = input.options;
		const taskOptions = {
			...otherOptions,
			...(authorization ? { authorizationScope: grantScopeHash(authorization) } : {}),
		};
		const grantLeases = new GrantLease(coordinator.store);
		if (authorization) await grantLeases.renew(rootRunId, authorization);
		const assertAuthorization = async () => {
			if (authorization) Object.assign(authorization, await grantLeases.current(rootRunId, authorization));
		};
		await assertAuthorization();
		const fingerprint = hashState(
			JSON.parse(
				JSON.stringify({
					configurationFingerprint,
					specId: input.specId,
					input: input.initialInput,
					options: taskOptions,
					payload: input.payload ?? null,
				}),
			),
		);
		const sessionLease = await coordinator.acquire({
			scope: hashState({
				sessionId: input.sessionId,
				...(authorization ? { tenantId: authorization.tenantId, userId: authorization.sub } : {}),
			}),
			runId: "session-lock",
			fingerprint: "session-lock-v1",
		});
		let lease: CheckpointLease;
		try {
			lease = await coordinator.acquire({ scope, runId: rootRunId, fingerprint });
		} catch (error) {
			await sessionLease.release("paused").catch(() => {});
			throw error;
		}
		const release = async (status: "paused" | "completed") => {
			const settled = await Promise.allSettled([lease.release(status), sessionLease.release("paused")]);
			const errors = settled.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
			if (errors.length) throw new AggregateError(errors, "lease release failed");
		};
		if (input.options.resumeFrom && !lease.checkpoint) {
			await release("paused");
			throw new Error("checkpoint_not_found");
		}
		let runtime: Runtime | undefined;
		let finalStatus: "paused" | "completed" = "paused";
		let ownershipLost: unknown;
		const controller = new AbortController();
		const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
		let checkingAuthorization = false;
		const expiryTimer = authorization
			? setInterval(() => {
					if (checkingAuthorization) return;
					checkingAuthorization = true;
					void assertAuthorization()
						.catch((error: unknown) => {
							ownershipLost = error;
							controller.abort(error);
							void runtime?.abort().catch(() => {});
						})
						.finally(() => {
							checkingAuthorization = false;
						});
				}, 1000)
			: undefined;
		const heartbeat = setInterval(
			() => {
				void Promise.all([lease.renew(), sessionLease.renew()]).catch((error: unknown) => {
					ownershipLost = error;
					controller.abort(error);
					void runtime?.abort().catch(() => {});
				});
			},
			Math.max(1, Math.floor(coordinator.leaseMs / 3)),
		);
		try {
			runtime = await factory({
				...input,
				signal,
				operationRunId: rootRunId,
				resume: lease.checkpoint as SessionCheckpoint | undefined,
				onCheckpoint: async (checkpoint) => {
					await assertAuthorization();
					if (checkpoint.runId !== input.runId || checkpoint.specId !== input.specId)
						throw new Error("checkpoint_identity_mismatch");
					const checkpointSeq = await lease.save(checkpoint);
					if (input.options.interaction && authorization) {
						const ids = checkpoint.pluginState?.consumedMessageIds;
						if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string") || ids.length > 1000)
							throw new Error("checkpoint_messages_invalid");
						await new SessionInbox(coordinator.store).acknowledge(authorization, rootRunId, ids, checkpointSeq);
					}
					fanOut({
						type: "checkpoint_saved",
						runId: input.runId,
						specId: input.specId,
						seq: 0,
						ts: Date.now(),
						payload: { checkpointSeq, fence: lease.fence, next: checkpoint.next },
					});
					await input.onCheckpoint?.(checkpoint);
				},
			});
		} catch (error) {
			if (expiryTimer) clearTimeout(expiryTimer);
			clearInterval(heartbeat);
			await release("paused").catch(() => {});
			throw error;
		}
		const inner = runtime;
		const unsubscribeInner = inner.subscribe(fanOut);
		let disposal: Promise<void> | undefined;
		return {
			getConversation: inner.getConversation ? () => inner.getConversation!() : undefined,
			id: inner.id,
			specId: inner.specId,
			sessionId: inner.sessionId,
			async run(text, options) {
				await assertAuthorization();
				if (text !== input.initialInput) throw new Error("checkpoint_input_mismatch");
				await lease.assertOwned();
				await sessionLease.assertOwned();
				const result = await inner.run(text, options);
				await assertAuthorization();
				if (ownershipLost) throw ownershipLost;
				await lease.assertOwned();
				await sessionLease.assertOwned();
				return result;
			},
			async confirmResultStored(result) {
				await assertAuthorization();
				await lease.assertOwned();
				finalStatus = result.status === "completed" ? "completed" : "paused";
			},
			steer: (text) => inner.steer(text),
			followUp: (text) => inner.followUp(text),
			abort: () => inner.abort(),
			waitForIdle: () => inner.waitForIdle(),
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			get isIdle() {
				return inner.isIdle;
			},
			get lastActiveAt() {
				return inner.lastActiveAt;
			},
			snapshot: () => inner.snapshot(),
			dispose() {
				disposal ??= (async () => {
					try {
						await inner.dispose();
					} finally {
						unsubscribeInner();
						listeners.clear();
						clearInterval(heartbeat);
						if (expiryTimer) clearTimeout(expiryTimer);
						await release(finalStatus);
					}
				})();
				return disposal;
			},
		};
	};
	return Object.assign(wrapped, {
		supportsResume: true as const,
		async registerPending(runId: string) {
			if (closed) throw new Error("durable_host_closed");
			activeRuns.add(runId);
			try {
				await writeHost();
				const key = JSON.stringify(["run-owner", runId]);
				if (!(await coordinator.store.compareAndSwap(key, null, { version: 1, hostId })))
					throw new Error("run_owner_conflict");
				hostHeartbeat ??= setInterval(
					() => {
						void writeHost().catch(() => {});
					},
					Math.max(1, Math.floor(coordinator.leaseMs / 3)),
				);
			} catch (error) {
				activeRuns.delete(runId);
				throw error;
			}
		},
		async unregisterPending(runId: string) {
			activeRuns.delete(runId);
			await writeHost();
		},
		async isRunActive(row: RunRecord) {
			const owner = await coordinator.store.get(JSON.stringify(["run-owner", row.runId]));
			if (!owner) return coordinator.now() - row.createdAt < coordinator.leaseMs;
			const host = await coordinator.store.get(JSON.stringify(["host", (owner.value as { hostId: string }).hostId]));
			const value = host?.value as { version: number; leaseUntil: number; activeRuns: string[] } | undefined;
			return (
				value?.version === 1 &&
				value.leaseUntil > coordinator.now() &&
				Array.isArray(value.activeRuns) &&
				value.activeRuns.includes(row.runId)
			);
		},
		async close() {
			closed = true;
			if (hostHeartbeat) clearInterval(hostHeartbeat);
			activeRuns.clear();
			await writeHost();
		},
	});
}
