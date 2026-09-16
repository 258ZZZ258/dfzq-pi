import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { McpClient } from "../src/toolsets/mcp/client.ts";

it("cancels a pending initialize, reaps its child and removes the signal listener", async () => {
	const root = await mkdtemp(join(tmpdir(), "init-cancel-"));
	const file = join(root, "pid");
	const controller = new AbortController();
	const startup = McpClient.spawn({
		id: "pending",
		command: process.execPath,
		args: [fileURLToPath(new URL("./fixtures/pending-init-mcp.mjs", import.meta.url))],
		env: { PID_FILE: file },
		requestTimeoutMs: 3000,
		signal: controller.signal,
	}).then(
		async (client) => {
			await client.dispose();
			return undefined;
		},
		(error: unknown) => error,
	);
	try {
		let pid = 0;
		await expect
			.poll(async () => {
				try {
					pid = Number(await readFile(file, "utf8"));
					return pid;
				} catch {
					return 0;
				}
			})
			.toBeGreaterThan(0);
		controller.abort();
		const error = await startup;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("aborted");
		expect(() => process.kill(pid, 0)).toThrow();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	} finally {
		controller.abort();
		await startup;
		await rm(root, { recursive: true, force: true });
	}
});
