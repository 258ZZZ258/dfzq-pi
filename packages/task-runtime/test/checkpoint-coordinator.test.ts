import { expect, it } from "vitest";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { createSqliteStateStore } from "../src/state/store.ts";

it("recovers the last checkpoint, fences stale owners and rejects changed configuration", async () => {
	const store = createSqliteStateStore(":memory:");
	let now = 0;
	try {
		const coordinator = new CheckpointCoordinator(store, { now: () => now, leaseMs: 10 });
		const identity = { scope: "s", runId: "r", fingerprint: "config-v1" };
		const first = await coordinator.acquire(identity);
		await first.save({ turns: 2, phase: "pending_tools" });
		await expect(coordinator.acquire(identity)).rejects.toThrow("task_in_progress");
		now = 11;
		const resumed = await coordinator.acquire(identity);
		expect(resumed.fence).toBeGreaterThan(first.fence);
		expect(resumed.checkpoint).toEqual({ turns: 2, phase: "pending_tools" });
		await expect(first.save({ turns: 99 })).rejects.toThrow("task_ownership_lost");
		await resumed.release("paused");
		await expect(coordinator.acquire({ ...identity, fingerprint: "config-v2" })).rejects.toThrow(
			"checkpoint_incompatible",
		);
		const final = await coordinator.acquire(identity);
		await final.release("completed");
		await expect(coordinator.acquire(identity)).rejects.toThrow("task_already_completed");
	} finally {
		await store.close();
	}
});
