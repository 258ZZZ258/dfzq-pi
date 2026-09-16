import { expect, it } from "vitest";
import { Gate } from "../src/server/gate.ts";
import { RunManager, type RuntimeFactory } from "../src/server/run-manager.ts";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { withDurableExecution } from "../src/state/durable-factory.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it("keeps a job resumable until the host explicitly acknowledges result persistence", async () => {
	const store = createSqliteStateStore(":memory:");
	const factory = withDurableExecution(async () => createStubRuntime(), new CheckpointCoordinator(store), "config");
	const input = {
		specId: "demo",
		sessionId: "s",
		runId: "r",
		initialInput: "q",
		filters: { corpusTypes: ["internal"] },
		options: {},
	};
	try {
		const first = await factory(input);
		await first.run("q", { runId: "r" });
		await first.dispose();
		const retry = await factory(input);
		const result = await retry.run("q", { runId: "r" });
		await retry.confirmResultStored?.(result);
		await retry.dispose();
		await expect(factory(input)).rejects.toThrow("task_already_completed");
	} finally {
		await factory.close?.();
		await store.close();
	}
});

it("does not fail another live host's queued job, but converges an orphan without any checkpoint", async () => {
	const state = createSqliteStateStore(":memory:");
	const rows = createSqliteRunStore(":memory:");
	const clock = () => 100000;
	const a = withDurableExecution(
		async () => createStubRuntime(),
		new CheckpointCoordinator(state, { now: clock }),
		"config",
	);
	const b = withDurableExecution(
		async () => createStubRuntime(),
		new CheckpointCoordinator(state, { now: clock }),
		"config",
	);
	try {
		rows.insertQueued({
			runId: "r",
			clientRequestId: "k",
			sessionId: "s",
			specId: "demo",
			taskKind: "demo",
			input: "q",
			filtersJson: "{}",
			createdAt: 1,
		});
		await a.registerPending?.("r");
		const manager = new RunManager({ store: rows, gate: new Gate(), runtimeFactory: b });
		expect((await manager.findRun("r"))?.status).toBe("queued");
		await a.unregisterPending?.("r");
		expect((await manager.findRun("r"))?.status).toBe("error");
		expect((await manager.findRun("r"))?.errorMessage).toBe("process_interrupted");
		expect(rows.markStale?.("r", "must not replace terminal", 100001)).toBe(false);
	} finally {
		await a.close?.();
		await b.close?.();
		await state.close();
		rows.close();
	}
});

it("recovers a run-store write failure instead of acknowledging the checkpoint as completed", async () => {
	const state = createSqliteStateStore(":memory:");
	const rows = createSqliteRunStore(":memory:");
	const factory: RuntimeFactory = withDurableExecution(
		async () => createStubRuntime(),
		new CheckpointCoordinator(state),
		"config",
	);
	const manager = new RunManager({
		store: {
			...rows,
			finish: () => {
				throw new Error("storage unavailable");
			},
			markError: () => {
				throw new Error("storage unavailable");
			},
		},
		gate: new Gate(),
		runtimeFactory: factory,
	});
	try {
		const accepted = await manager.submit({
			specId: "demo",
			taskKind: "demo",
			sessionId: "s",
			clientRequestId: "k",
			input: "q",
			filters: { corpusTypes: ["internal"] },
		});
		if (accepted.kind !== "accepted") throw new Error("expected accepted");
		await expect(accepted.completion).rejects.toThrow("storage unavailable");
		await expect.poll(async () => (await manager.findRun(accepted.runId))?.status).toBe("error");
	} finally {
		await manager.shutdown();
		await state.close();
		rows.close();
	}
});
