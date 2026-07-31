import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunResult, Runtime } from "../src/runtime/contract.ts";

describe("runtime contract", () => {
	it("a minimal object satisfies Runtime", async () => {
		const result: RunResult = {
			runId: "r1",
			specId: "spec1",
			status: "completed",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0 },
			turns: 1,
			durationMs: 5,
			judgeAttempts: {},
		};
		const rt: Runtime = {
			id: "rt1",
			specId: "spec1",
			sessionId: "s1",
			run: async () => result,
			steer: async () => {},
			followUp: async () => {},
			abort: async () => {},
			waitForIdle: async () => {},
			subscribe: () => () => {},
			isIdle: true,
			lastActiveAt: 0,
			snapshot: () => ({ sessionId: "s1" }),
			dispose: async () => {},
		};
		expect((await rt.run("hi")).status).toBe("completed");
	});

	it("does not import any pi package (isolation boundary)", () => {
		const src = readFileSync(fileURLToPath(new URL("../src/runtime/contract.ts", import.meta.url)), "utf8");
		expect(src).not.toContain("@earendil-works");
	});
});
