import { expect, it } from "vitest";
import { MemoryService } from "../src/memory/service.ts";
import { SpecRouter } from "../src/router/router.ts";
import { createApp } from "../src/server/app.ts";
import { Gate } from "../src/server/gate.ts";
import { startServer } from "../src/server/main.ts";
import { RunManager, type RuntimeFactory } from "../src/server/run-manager.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { javaGrantFixture } from "./helpers/java-grant.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it("refuses production database mode before IO when the grant verifier is missing", async () => {
	await expect(
		startServer({
			port: 0,
			databaseUrl: "must-not-connect",
			specsDir: "unused",
			internalToken: "test",
			runtimeFactory: async () => createStubRuntime(),
		}),
	).rejects.toThrow("grant_verifier_required");
});

it("enforces signed actor ownership, scoped idempotency, action and memory permissions over HTTP", async () => {
	const java = javaGrantFixture(),
		store = createSqliteRunStore(":memory:"),
		state = createSqliteStateStore(":memory:");
	const inputs: Array<Parameters<RuntimeFactory>[0]> = [];
	const manager = new RunManager({
		store,
		gate: new Gate(),
		runtimeFactory: async (input) => {
			inputs.push(input);
			return createStubRuntime();
		},
	});
	const app = createApp({
		store,
		manager,
		memory: new MemoryService(state),
		internalToken: "internal",
		grants: java.verifier,
		router: new SpecRouter([
			{ id: "demo", model: { role: "main" }, toolset: "t", tools: ["echo"], limits: { maxTurns: 3 } },
		]),
	});
	const request = (path: string, method = "GET", body?: unknown, token = java.token()) =>
		app.request(
			new Request(`http://local${path}`, {
				method,
				headers: {
					"content-type": "application/json",
					"x-internal-token": "internal",
					authorization: `Bearer ${token}`,
					"x-user-id": "spoofed",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	try {
		const body = {
			taskKind: "demo",
			input: "hello",
			sessionId: "s1",
			clientRequestId: "same",
			filters: { corpusTypes: ["internal", "external"], permTags: ["d1", "admin"] },
		};
		expect((await request("/runs", "POST", body, "bad-token")).status).toBe(401);
		const first = await request("/runs", "POST", body);
		expect(first.status).toBe(200);
		const result = (await first.json()) as { runId: string };
		expect(JSON.parse(store.findByRunId(result.runId)!.principalJson!)).toEqual({ tenantId: "t1", userId: "u1" });
		expect(inputs[0].filters).toMatchObject({ corpusTypes: ["internal"], permTags: ["d1"] });
		expect((await request(`/runs/${result.runId}`, "GET", undefined, java.token({ sub: "u2" }))).status).toBe(403);
		expect(
			(await request(`/runs/${result.runId}`, "GET", undefined, java.token({ actions: ["run:create"] }))).status,
		).toBe(403);
		expect(
			(
				await request(
					`/runs/${result.runId}`,
					"GET",
					undefined,
					java.token({ dataScope: { corpusTypes: ["internal"], permTags: ["other"] } }),
				)
			).status,
		).toBe(403);
		const other = await request("/runs", "POST", body, java.token({ tenantId: "t2" }));
		expect(other.status).toBe(200);
		expect(((await other.json()) as { runId: string }).runId).not.toBe(result.runId);
		expect(
			(
				await request(
					"/memories",
					"POST",
					{ requestId: "m", text: "private" },
					java.token({ actions: ["memory:read"] }),
				)
			).status,
		).toBe(403);
		expect((await request("/memories", "POST", { requestId: "m", text: "private" })).status).toBe(200);
		expect((await request("/memories?sessionId=other")).status).toBe(403);
		expect((await request("/library/external-documents")).status).toBe(403);
	} finally {
		await manager.shutdown();
		store.close();
		await state.close();
	}
});
