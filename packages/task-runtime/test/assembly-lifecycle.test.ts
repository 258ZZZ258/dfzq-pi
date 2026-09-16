import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { Gate } from "../src/server/gate.ts";
import { createDefaultRuntimeFactory } from "../src/server/main.ts";
import { RunManager } from "../src/server/run-manager.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";

it.each(["cancel", "timeout"] as const)(
	"%s during production MCP assembly releases the gate and reaps the child",
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "assembly-life-"));
		const pidFile = join(root, "pid");
		const store = createSqliteRunStore(":memory:");
		vi.stubEnv("ASSEMBLY_TEST_KEY", "local-only");
		try {
			const specsDir = join(root, "specs");
			await mkdir(specsDir);
			await writeFile(
				join(root, "profile.json"),
				JSON.stringify({
					id: "local",
					baseUrl: "http://127.0.0.1:1/v1",
					apiKeyEnv: "ASSEMBLY_TEST_KEY",
					api: "openai-completions",
					roles: {
						main: {
							provider: "local",
							modelId: "mock",
							contextWindow: 8192,
							maxTokens: 1024,
							reasoning: false,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					},
				}),
			);
			await writeFile(
				join(specsDir, "demo.json"),
				JSON.stringify({
					id: "demo",
					model: { role: "main" },
					toolset: "mcp",
					tools: ["echo"],
					limits: { maxTurns: 5 },
					mcpServers: [
						{
							id: "pending",
							command: process.execPath,
							args: [fileURLToPath(new URL("./fixtures/pending-init-mcp.mjs", import.meta.url))],
							env: { PID_FILE: pidFile },
							requestTimeoutMs: 5000,
						},
					],
				}),
			);
			const factory = await createDefaultRuntimeFactory({
				profilePath: join(root, "profile.json"),
				specsDir,
				workRoot: join(root, "runs"),
				assemblyTimeoutMs: mode === "timeout" ? 1000 : 5000,
			});
			const gate = new Gate({ maxConcurrent: 1 });
			const manager = new RunManager({ store, gate, runtimeFactory: factory });
			const accepted = await manager.submit({
				taskKind: "demo",
				specId: "demo",
				clientRequestId: "k",
				sessionId: "s",
				input: "q",
				filters: { corpusTypes: ["internal"] },
			});
			if (accepted.kind !== "accepted") throw new Error("expected accepted");
			const completion = accepted.completion.then(
				(result) => result,
				(error: unknown) => error,
			);
			let pid = 0;
			await expect
				.poll(async () => {
					try {
						pid = Number(await readFile(pidFile, "utf8"));
						return pid;
					} catch {
						return 0;
					}
				})
				.toBeGreaterThan(0);
			if (mode === "cancel") expect(await manager.cancel(accepted.runId)).toBe("accepted");
			const outcome = await completion;
			if (mode === "cancel") expect(outcome).toMatchObject({ status: "aborted", turns: 0 });
			else expect(outcome).toMatchObject({ message: "assembly_timeout" });
			expect(store.findByRunId(accepted.runId)?.status).toBe(mode === "cancel" ? "aborted" : "error");
			expect(JSON.parse(store.findByRunId(accepted.runId)?.deliveryJson ?? "null")).toMatchObject({
				validation: "not_checked",
				error: { code: mode === "cancel" ? "cancelled" : "assembly_timeout" },
			});
			expect(gate.activeCount).toBe(0);
			expect(manager.activeRuns).toBe(0);
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			store.close();
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	},
);
