import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachTrajectory, readTrajectory } from "../src/observability/trajectory.ts";
import type { Runtime, RuntimeEvent } from "../src/runtime/contract.ts";

let root: string;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

function fakeRuntime() {
	const listeners = new Set<(event: RuntimeEvent) => void>();
	const runtime = {
		subscribe: (listener: (event: RuntimeEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as Runtime;
	const emit = (event: Partial<RuntimeEvent>) => {
		const full: RuntimeEvent = {
			runId: "r1",
			specId: "s1",
			seq: 0,
			ts: 1,
			type: "turn_end",
			payload: {},
			...event,
		};
		for (const listener of listeners) listener(full);
	};
	return { runtime, emit };
}

describe("trajectory", () => {
	it("writes whitelisted events as JSONL and reads them back", async () => {
		root = await mkdtemp(join(tmpdir(), "traj-"));
		const file = join(root, "trajectory.jsonl");
		const { runtime, emit } = fakeRuntime();
		const detach = await attachTrajectory(runtime, file);
		emit({ seq: 0, type: "turn_start" });
		emit({ seq: 1, type: "tool_execution_end", payload: { toolName: "echo" } });
		emit({ seq: 2, type: "auto_retry_start" });
		await detach();

		const events = await readTrajectory(file);
		expect(events.map((e) => e.type)).toEqual(["turn_start", "tool_execution_end", "auto_retry_start"]);
		expect(events[1].payload).toMatchObject({ toolName: "echo" });
	});

	it("drops non-whitelisted noise events", async () => {
		root = await mkdtemp(join(tmpdir(), "traj-"));
		const file = join(root, "trajectory.jsonl");
		const { runtime, emit } = fakeRuntime();
		const detach = await attachTrajectory(runtime, file);
		emit({ seq: 0, type: "text_delta" });
		emit({ seq: 1, type: "turn_end" });
		await detach();

		const events = await readTrajectory(file);
		expect(events.map((e) => e.type)).toEqual(["turn_end"]);
	});

	it("preserves seq order in the file", async () => {
		root = await mkdtemp(join(tmpdir(), "traj-"));
		const file = join(root, "trajectory.jsonl");
		const { runtime, emit } = fakeRuntime();
		const detach = await attachTrajectory(runtime, file);
		for (let i = 0; i < 20; i++) emit({ seq: i, type: "turn_end" });
		await detach();

		const events = await readTrajectory(file);
		expect(events.map((e) => e.seq)).toEqual([...Array(20).keys()]);
	});

	it("detach is idempotent and does not hang on repeated calls", { timeout: 5000 }, async () => {
		root = await mkdtemp(join(tmpdir(), "traj-"));
		const file = join(root, "trajectory.jsonl");
		const { runtime, emit } = fakeRuntime();
		const detach = await attachTrajectory(runtime, file);
		emit({ seq: 0, type: "turn_start" });

		// First detach
		await detach();

		// Second detach should return immediately without hanging
		await detach();

		const events = await readTrajectory(file);
		expect(events.length).toBe(1);
	});

	it("handles write stream errors without crashing the process", { timeout: 5000 }, async () => {
		root = await mkdtemp(join(tmpdir(), "traj-"));
		const file = join(root, "trajectory.jsonl");
		const { runtime, emit } = fakeRuntime();
		const detach = await attachTrajectory(runtime, file);

		emit({ seq: 0, type: "turn_start" });

		// Delete the directory to cause subsequent writes to fail
		await rm(root, { recursive: true });

		// Emit another event—this should fail but not crash the process
		emit({ seq: 1, type: "turn_end" });

		// Give error handler time to run
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Should be able to detach without crashing
		await detach();

		// If we got here, process didn't crash
		expect(true).toBe(true);
	});

	it("handles truncated JSON at end of file", async () => {
		root = await mkdtemp(join(tmpdir(), "traj-"));
		const file = join(root, "trajectory.jsonl");

		// Write a truncated JSONL file manually
		const fs = await import("node:fs/promises");
		const completeEvent: RuntimeEvent = {
			runId: "r1",
			specId: "s1",
			seq: 0,
			ts: 1,
			type: "turn_start",
			payload: {},
		};
		const truncatedEvent = JSON.stringify({
			runId: "r1",
			specId: "s1",
			seq: 1,
			ts: 2,
			type: "turn_end",
			payload: {},
		}).slice(0, -10); // Truncate the event

		await fs.writeFile(file, `${JSON.stringify(completeEvent)}\n${truncatedEvent}`);

		const events = await readTrajectory(file);
		expect(events.length).toBe(1); // Only the complete event
		expect(events[0].type).toBe("turn_start");
	});
});
