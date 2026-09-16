import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startServer } from "../src/server/main.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it.each([
	{ hostname: undefined, expected: "127.0.0.1" },
	{ hostname: "0.0.0.0", expected: "0.0.0.0" },
])("binds $expected and serves HTTP", async ({ hostname, expected }) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-bind-"));
	const listen = vi.spyOn(Server.prototype, "listen");
	let server: Awaited<ReturnType<typeof startServer>> | undefined;
	try {
		await writeFile(
			join(directory, "test.json"),
			JSON.stringify({
				id: "test",
				model: { role: "main" },
				toolset: "test",
				tools: ["test"],
				limits: { maxTurns: 1 },
			}),
		);
		server = await startServer({
			port: 0,
			hostname,
			dbPath: ":memory:",
			specsDir: directory,
			internalToken: "test",
			runtimeFactory: async () => createStubRuntime(),
		});
		expect(listen.mock.calls.some((args) => args.includes(expected))).toBe(true);
		const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(response.status).toBe(200);
	} finally {
		await server?.close();
		listen.mockRestore();
		await rm(directory, { recursive: true, force: true });
	}
});
