import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createWorkerRuntime } from "../src/worker/runtime.ts";

it.each(["cancel", "timeout"] as const)("hard %s terminates blocked JS and its child process", async (mode) => {
	const dir = await mkdtemp(join(tmpdir(), "hard-worker-"));
	const pidFile = join(dir, "child.pid");
	const rt = await createWorkerRuntime(
		{ profilePath: "unused", specsDir: "unused", workRoot: dir },
		{ specId: "demo", sessionId: "s", runId: "r", filters: { corpusTypes: ["internal"] }, options: {} },
		{
			env: { PATH: process.env.PATH ?? "", PID_FILE: pidFile },
			stopGraceMs: 100,
			runTimeoutMs: mode === "timeout" ? 500 : 5000,
			entryPath: fileURLToPath(new URL("./fixtures/blocked-worker.mjs", import.meta.url)),
		},
	);
	try {
		const completion = rt.run("q");
		let child = 0;
		await expect
			.poll(async () => {
				try {
					child = Number(await readFile(pidFile, "utf8"));
					return child;
				} catch {
					return 0;
				}
			})
			.toBeGreaterThan(0);
		if (mode === "cancel") await rt.abort();
		expect(await completion).toMatchObject({
			status: mode === "cancel" ? "aborted" : "limit_exceeded",
			telemetryIncomplete: true,
		});
		expect(() => process.kill(rt.workerPid, 0)).toThrow();
		await expect
			.poll(() => {
				try {
					process.kill(child, 0);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(false);
	} finally {
		await rt.dispose().catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});
