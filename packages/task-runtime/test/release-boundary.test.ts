import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { ACTIONS } from "../src/auth/grant.ts";
import { loadSpecRouter } from "../src/router/router.ts";
import { createApp } from "../src/server/app.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager } from "../src/server/run-manager.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { authorizedToolset } from "../src/toolsets/authorized.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it("excludes optimization surfaces while preserving report task registration", async () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	for (const path of [
		"src/selfopt",
		"frozen-eval",
		"src/cli/optimize.ts",
		"src/cli/evidence.ts",
		"src/cli/apply-proposals.ts",
		"specs/selfopt-optimizer.json",
	])
		expect(existsSync(`${root}${path}`)).toBe(false);
	expect(ACTIONS as readonly string[]).not.toContain("run:feedback");
	const router = await loadSpecRouter(`${root}specs`);
	expect(router.resolve("audit-report")?.durableSession).toBe(false);
	expect(router.resolve("supervision-analysis")?.durableSession).toBe(false);
	expect(router.resolve("selfopt-optimizer")).toBeUndefined();
	const store = createSqliteRunStore(":memory:"),
		manager = new RunManager({ store, gate: new Gate(), runtimeFactory: async () => createStubRuntime() });
	try {
		const app = createApp({ store, manager, router, internalToken: "test" });
		expect(
			(await app.request("http://local/runs/unknown/feedback", { headers: { "x-internal-token": "test" } })).status,
		).toBe(404);
	} finally {
		await manager.shutdown();
		store.close();
	}
});

it("checks native tool permissions before effects and again after async execution", async () => {
	let allowed = true,
		calls = 0;
	const provider = authorizedToolset(
		async () => [
			{
				name: "native",
				label: "native",
				description: "native",
				parameters: Type.Object({}),
				execute: async () => {
					calls++;
					allowed = false;
					return { content: [{ type: "text" as const, text: "private" }], details: {} };
				},
			},
		],
		async () => {
			if (!allowed) throw new Error("revoked");
		},
	);
	const handle = await provider();
	if (Array.isArray(handle)) throw new Error("expected handle");
	await expect(handle.tools[0].execute("c", {}, undefined, undefined, {} as never)).rejects.toThrow("revoked");
	await expect(handle.tools[0].execute("next", {}, undefined, undefined, {} as never)).rejects.toThrow("revoked");
	expect(calls).toBe(1);
});
