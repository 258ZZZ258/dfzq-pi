import { describe, expect, it } from "vitest";
import { SpecRouter } from "../src/router/router.ts";
import type { RunResult } from "../src/runtime/contract.ts";
import { createApp } from "../src/server/app.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager, type SubmitRequest } from "../src/server/run-manager.ts";
import type { NewRun, RunRecord, RunStore, StoredEvent } from "../src/store/contract.ts";
import { createStubRuntime, type StubRuntime } from "./helpers/stub-runtime.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<void>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

function request(overrides: Partial<SubmitRequest> = {}): SubmitRequest {
	return {
		taskKind: "demo",
		specId: "demo",
		input: "hello",
		clientRequestId: "cli-1",
		sessionId: "sess-1",
		filters: { permTags: [], corpusTypes: ["internal"] },
		...overrides,
	};
}

function cloneRun(row: RunRecord): RunRecord {
	return { ...row, sourceDetails: row.sourceDetails?.map((source) => ({ ...source })) };
}

function runResult(runId: string, specId = "demo", overrides: Partial<RunResult> = {}): RunResult {
	return {
		runId,
		specId,
		status: "completed",
		output: "stub output",
		usage: { ...ZERO_USAGE },
		turns: 1,
		durationMs: 1,
		judgeAttempts: {},
		...overrides,
	};
}

class MemoryRunStore implements RunStore<true> {
	private readonly rowsByRunId = new Map<string, RunRecord>();
	private readonly runIdByClientRequestId = new Map<string, string>();
	private readonly eventsByRunId = new Map<string, StoredEvent[]>();
	private deletePause:
		| {
				runId: string;
				started: ReturnType<typeof deferred>;
				release: ReturnType<typeof deferred>;
		  }
		| undefined;

	pauseDeleteRun(runId: string): { started: Promise<void>; release: () => void } {
		const started = deferred();
		const release = deferred();
		this.deletePause = { runId, started, release };
		return { started: started.promise, release: () => release.resolve() };
	}

	async insertQueued(rec: NewRun): Promise<{ inserted: boolean; run: RunRecord }> {
		const existingRunId = this.runIdByClientRequestId.get(rec.clientRequestId);
		if (existingRunId) {
			const existing = this.rowsByRunId.get(existingRunId);
			if (!existing) throw new Error(`Idempotency conflict on "${rec.clientRequestId}" but no existing row`);
			return { inserted: false, run: cloneRun(existing) };
		}

		const row: RunRecord = { ...rec, status: "queued" };
		this.rowsByRunId.set(row.runId, row);
		this.runIdByClientRequestId.set(row.clientRequestId, row.runId);
		return { inserted: true, run: cloneRun(row) };
	}

	async findByRunId(runId: string): Promise<RunRecord | undefined> {
		const row = this.rowsByRunId.get(runId);
		return row ? cloneRun(row) : undefined;
	}

	async findByClientRequestId(key: string): Promise<RunRecord | undefined> {
		const runId = this.runIdByClientRequestId.get(key);
		return runId ? this.findByRunId(runId) : undefined;
	}

	async markRunning(runId: string, startedAt: number): Promise<void> {
		const row = this.requireRun(runId);
		row.status = "running";
		row.startedAt = startedAt;
	}

	async finish(runId: string, result: RunResult, finishedAt: number): Promise<void> {
		const row = this.requireRun(runId);
		row.status = result.status;
		row.output = result.output;
		row.errorMessage = result.errorMessage;
		row.stopReason = result.stopReason;
		row.limitHit = result.limit;
		row.usageJson = JSON.stringify(result.usage);
		row.turns = result.turns;
		row.sourceDetails = result.sourceDetails;
		row.finishedAt = finishedAt;
	}

	async markError(runId: string, message: string, finishedAt: number): Promise<void> {
		const row = this.requireRun(runId);
		row.status = "error";
		row.errorMessage = message;
		row.finishedAt = finishedAt;
	}

	async deleteRun(runId: string): Promise<void> {
		const pause = this.deletePause;
		if (pause?.runId === runId) {
			pause.started.resolve();
			await pause.release.promise;
			this.deletePause = undefined;
		}
		const row = this.rowsByRunId.get(runId);
		if (!row) return;
		this.rowsByRunId.delete(runId);
		this.runIdByClientRequestId.delete(row.clientRequestId);
		this.eventsByRunId.delete(runId);
	}

	async recoverStaleRuns(now: number): Promise<number> {
		let recovered = 0;
		for (const row of this.rowsByRunId.values()) {
			if (row.status === "queued" || row.status === "running") {
				row.status = "error";
				row.errorMessage = "process restarted";
				row.finishedAt = now;
				recovered++;
			}
		}
		return recovered;
	}

	async appendEvents(runId: string, events: StoredEvent[]): Promise<void> {
		const existing = this.eventsByRunId.get(runId) ?? [];
		existing.push(...events);
		this.eventsByRunId.set(runId, existing);
	}

	async listEvents(runId: string): Promise<StoredEvent[]> {
		return [...(this.eventsByRunId.get(runId) ?? [])];
	}

	async close(): Promise<void> {}

	private requireRun(runId: string): RunRecord {
		const row = this.rowsByRunId.get(runId);
		if (!row) throw new Error(`Run "${runId}" not found`);
		return row;
	}
}

describe("R07 admission and idempotency regressions", () => {
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid maxConcurrent=%s", (maxConcurrent) => {
		expect(() => new Gate({ maxConcurrent, maxQueueDepth: 1 })).toThrow(/maxConcurrent/i);
	});

	it("keeps HTTP retries stable with generated sessions and rejects changed request content", async () => {
		const store = new MemoryRunStore();
		const runtime = createStubRuntime();
		const manager = new RunManager({ store, gate: new Gate(), runtimeFactory: async () => runtime });
		const router = new SpecRouter([
			{ id: "demo", model: { role: "main" }, toolset: "t", tools: ["echo"], limits: { maxTurns: 2 } },
		]);
		const app = createApp({ manager, router, store, internalToken: "local-test" });
		const body = {
			taskKind: "demo",
			input: "original",
			clientRequestId: "http-key",
			filters: { corpusTypes: ["internal"], permTags: [] },
		};
		const submit = (value: unknown) =>
			app.request("/runs", {
				method: "POST",
				headers: { "X-Internal-Token": "local-test", "content-type": "application/json" },
				body: JSON.stringify(value),
			});
		const first = await submit(body);
		expect(first.status).toBe(200);
		const firstResult = (await first.json()) as { runId: string };
		const repeated = await submit({ ...body, filters: { permTags: [], corpusTypes: ["internal"] } });
		expect(repeated.status).toBe(200);
		expect(((await repeated.json()) as { runId: string }).runId).toBe(firstResult.runId);
		for (const change of [
			{ input: "changed" },
			{ sessionId: "another-session" },
			{ filters: { corpusTypes: ["external"] } },
			{ payload: { a: 1 } },
			{ options: { topK: 1 } },
		]) {
			const conflict = await submit({ ...body, ...change });
			expect(conflict.status).toBe(409);
			expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
		}
		expect(runtime.runCalls).toBe(1);
		const explicitBody = { ...body, clientRequestId: "explicit-key", sessionId: "s1" };
		expect((await submit(explicitBody)).status).toBe(200);
		const omitted = await submit({ ...body, clientRequestId: "explicit-key" });
		expect(omitted.status).toBe(409);
		expect(await omitted.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
	});

	it("cancels a queued run immediately, freeing queue capacity and its session while the active run stays held", async () => {
		const store = new MemoryRunStore();
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 1 });
		const stubs: StubRuntime[] = [];
		let n = 0;
		const manager = new RunManager({
			store,
			gate,
			runtimeFactory: async () => {
				const stub = createStubRuntime({ hang: true });
				stubs.push(stub);
				return stub;
			},
			now: () => 1000,
			newRunId: () => `run-${++n}`,
		});

		const active = await manager.submit(request({ sessionId: "s-active" }));
		if (active.kind !== "accepted") throw new Error("expected active run to be accepted");
		const queued = await manager.submit(request({ clientRequestId: "cli-queued", sessionId: "s-queued" }));
		if (queued.kind !== "accepted") throw new Error("expected queued run to be accepted");
		expect(queued.queued).toBe(true);

		let sameSession: Awaited<ReturnType<RunManager["submit"]>> | undefined;
		try {
			expect(await manager.cancel(queued.runId)).toBe("accepted");
			expect(await store.findByRunId(queued.runId)).toMatchObject({ status: "aborted", finishedAt: 1000 });
			await expect(queued.completion).resolves.toMatchObject({ status: "aborted" });
			expect(gate.activeCount).toBe(1);
			expect(gate.queueDepth).toBe(0);
			expect(stubs).toHaveLength(1);

			sameSession = await manager.submit(
				request({ clientRequestId: "cli-same-session-after-cancel", sessionId: "s-queued" }),
			);
			expect(sameSession.kind).toBe("accepted");
			if (sameSession.kind === "accepted") expect(sameSession.queued).toBe(true);
			expect(gate.queueDepth).toBe(1);
		} finally {
			stubs[0]?.resolveNow();
			if (active.kind === "accepted") await active.completion.catch(() => {});
			stubs[1]?.resolveNow();
			if (sameSession?.kind === "accepted") await sameSession.completion.catch(() => {});
		}
	});

	it("does not return a deleted run id to a duplicate while async rejection rollback is still in flight", async () => {
		const store = new MemoryRunStore();
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 0 });
		const activeRuntime = createStubRuntime({ hang: true });
		let n = 0;
		const manager = new RunManager({
			store,
			gate,
			runtimeFactory: async () => activeRuntime,
			now: () => 1000,
			newRunId: () => `run-${++n}`,
		});

		const active = await manager.submit(request({ sessionId: "s-active" }));
		if (active.kind !== "accepted") throw new Error("expected active run to be accepted");

		const rollback = store.pauseDeleteRun("run-2");
		const rejectedAttempt = manager.submit(request({ clientRequestId: "cli-race", sessionId: "s-over-capacity" }));
		await rollback.started;

		const duplicate = manager.submit(request({ clientRequestId: "cli-race", sessionId: "s-over-capacity" }));
		rollback.release();
		const [rejected, duplicateOutcome] = await Promise.all([rejectedAttempt, duplicate]);

		try {
			expect(rejected).toEqual({
				kind: "rejected",
				rejection: { kind: "queue_full", retryAfterSeconds: 5 },
			});
			expect(duplicateOutcome).toEqual({
				kind: "rejected",
				rejection: { kind: "queue_full", retryAfterSeconds: 5 },
			});
			expect(await store.findByRunId("run-2")).toBeUndefined();
			expect(duplicateOutcome).not.toMatchObject({ runId: "run-2" });
		} finally {
			activeRuntime.resolveNow();
			await active.completion.catch(() => {});
		}
	});

	it("conflicts when a reused clientRequestId changes the input instead of returning the old result", async () => {
		const store = new MemoryRunStore();
		const runtime = createStubRuntime({
			result: runResult("run-1", "demo", { output: "original output" }),
		});
		const manager = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 1 }),
			runtimeFactory: async () => runtime,
			now: () => 1000,
			newRunId: (() => {
				let n = 0;
				return () => `run-${++n}`;
			})(),
		});

		const first = await manager.submit(request({ clientRequestId: "cli-conflict", input: "original" }));
		if (first.kind !== "accepted") throw new Error("expected first run to be accepted");
		await first.completion;
		expect(await store.findByRunId(first.runId)).toMatchObject({ output: "original output" });

		const changed = await manager.submit(request({ clientRequestId: "cli-conflict", input: "changed" }));
		expect(changed).toMatchObject({ kind: "idempotency_conflict" });
		expect(runtime.runCalls).toBe(1);
	});
});
