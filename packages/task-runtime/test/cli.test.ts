import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

let root: string;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

describe("cli", () => {
	it("exits non-zero with a readable error when the spec file is missing", async () => {
		await expect(run(process.execPath, [CLI, "run", "--spec", "/nope.json", "--input", "hi"])).rejects.toMatchObject({
			code: 1,
		});
	});

	it("reports the missing api key env var by name", async () => {
		root = await mkdtemp(join(tmpdir(), "cli-"));
		const specPath = join(root, "spec.json");
		const profilePath = join(root, "profile.json");
		await writeFile(
			specPath,
			JSON.stringify({
				id: "demo",
				model: { role: "main" },
				toolset: "mcp",
				tools: ["echo"],
				limits: { maxTurns: 3 },
				mcpServers: [{ id: "echo", command: process.execPath, args: [SERVER], env: {} }],
			}),
		);
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "test",
				baseUrl: "http://localhost/v1",
				apiKeyEnv: "DFZQ_ABSENT_KEY",
				api: "openai-completions",
				roles: {
					main: {
						provider: "p",
						modelId: "m",
						contextWindow: 8192,
						maxTokens: 1024,
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);
		await expect(
			run(process.execPath, [
				CLI,
				"run",
				"--spec",
				specPath,
				"--profile",
				profilePath,
				"--workdir",
				root,
				"--input",
				"hi",
			]),
		).rejects.toMatchObject({ stderr: expect.stringContaining("DFZQ_ABSENT_KEY") });
	});
});
