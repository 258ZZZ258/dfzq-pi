import { expect, it } from "vitest";
import { Gate } from "../src/server/gate.ts";
import { RunManager } from "../src/server/run-manager.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it("does not publish completed until asynchronous event persistence drains", async () => {
	const store = createSqliteRunStore(":memory:");
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = false;
	const runtime = createStubRuntime({
		events: [{ seq: 0, type: "tool_execution_end", payload: { toolName: "echo", toolCallId: "c" } }],
	});
	const manager = new RunManager({
		gate: new Gate(),
		runtimeFactory: async () => runtime,
		store: {
			...store,
			async appendEvents(id, events) {
				started = true;
				await pending;
				store.appendEvents(id, events);
			},
		},
	});
	try {
		const outcome = await manager.submit({
			taskKind: "demo",
			specId: "demo",
			input: "q",
			sessionId: "s",
			clientRequestId: "c",
			filters: { corpusTypes: [] },
		});
		if (outcome.kind !== "accepted") throw new Error("not accepted");
		await expect.poll(() => started).toBe(true);
		expect(store.findByRunId(outcome.runId)?.status).toBe("running");
		release();
		expect((await outcome.completion).status).toBe("completed");
		expect(store.listEvents(outcome.runId)).toHaveLength(1);
	} finally {
		release();
		await manager.shutdown();
		store.close();
	}
});

it("event persistence rejection cannot silently certify a successful run", async () => {
	const store = createSqliteRunStore(":memory:");
	const runtime = createStubRuntime({
		events: [{ seq: 0, type: "tool_execution_end", payload: { toolName: "echo" } }],
	});
	const manager = new RunManager({
		gate: new Gate(),
		runtimeFactory: async () => runtime,
		store: {
			...store,
			async appendEvents() {
				throw new Error("disk unavailable");
			},
		},
	});
	try {
		const outcome = await manager.submit({
			taskKind: "demo",
			specId: "demo",
			input: "q",
			sessionId: "s",
			clientRequestId: "c",
			filters: { corpusTypes: [] },
		});
		if (outcome.kind !== "accepted") throw new Error("not accepted");
		await expect(outcome.completion).rejects.toThrow("event_persistence_failed");
		expect(store.findByRunId(outcome.runId)?.status).toBe("error");
		expect(manager.activeRuns).toBe(0);
	} finally {
		await manager.shutdown();
		store.close();
	}
});
