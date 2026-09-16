import { afterEach, describe, expect, it } from "vitest";
import { SpecRouter } from "../src/router/router.ts";
import { createApp } from "../src/server/app.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager } from "../src/server/run-manager.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { javaGrantFixture } from "./helpers/java-grant.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

const store = createSqliteRunStore(":memory:");
let assemblies = 0;
const manager = new RunManager({
	store,
	gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 1, retryAfterSeconds: 3 }),
	runtimeFactory: async () => {
		assemblies++;
		throw new Error("lookup must not assemble a runtime");
	},
});
const app = createApp({ manager, store, router: new SpecRouter([]), internalToken: "test-only" });
const body = {
	taskKind: "audit-report",
	input: "same input",
	sessionId: "task-1",
	clientRequestId: "lookup-key",
	filters: { owner: "alice", corpusTypes: ["internal"] },
	options: { reportType: "regular" },
	payload: { schemaVersion: "test", amount: 1.5 },
};

afterEach(() => {
	store.deleteRun("existing");
});

function seed() {
	store.insertQueued({
		runId: "existing",
		clientRequestId: body.clientRequestId,
		specId: "audit-report",
		taskKind: body.taskKind,
		sessionId: body.sessionId,
		input: body.input,
		filtersJson: JSON.stringify(body.filters),
		optionsJson: JSON.stringify(body.options),
		payloadJson: JSON.stringify(body.payload),
		createdAt: Date.now(),
	});
}

function lookup(value: unknown, token = "test-only") {
	return app.request("http://local/runs/lookup", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-internal-token": token,
		},
		body: JSON.stringify(value),
	});
}

describe("read-only run reconciliation", () => {
	it("requires the internal token", async () => {
		seed();
		expect((await lookup(body, "wrong")).status).toBe(401);
	});
	it("returns the original run without submitting", async () => {
		seed();
		const response = await lookup(body);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ runId: "existing", status: "queued", clientRequestId: "lookup-key" });
		expect(assemblies).toBe(0);
	});
	it("rejects changed authorization or facts", async () => {
		seed();
		expect((await lookup({ ...body, filters: { ...body.filters, owner: "bob" } })).status).toBe(409);
		expect((await lookup({ ...body, payload: { ...body.payload, amount: 2 } })).status).toBe(409);
		expect((await lookup({ ...body, sessionId: "other-task" })).status).toBe(409);
	});
	it("does not create a run for an absent key", async () => {
		expect((await lookup(body)).status).toBe(404);
		expect(store.findByClientRequestId(body.clientRequestId)).toBeUndefined();
		expect(assemblies).toBe(0);
	});
	it("looks up a terminal run after recovery without returning its payload", async () => {
		seed();
		store.recoverStaleRuns(Date.now());
		const response = await lookup(body);
		expect(await response.json()).toEqual({ runId: "existing", status: "error", clientRequestId: "lookup-key" });
	});
});

it("reconciles a signed submission using its scoped key and rejects another actor or changed grant scope", async () => {
	const localStore = createSqliteRunStore(":memory:");
	const localManager = new RunManager({
		store: localStore,
		gate: new Gate(),
		runtimeFactory: async () => createStubRuntime(),
	});
	const java = javaGrantFixture();
	const secured = createApp({
		store: localStore,
		manager: localManager,
		internalToken: "test-only",
		grants: java.verifier,
		router: new SpecRouter([
			{ id: "demo", model: { role: "main" }, toolset: "test", tools: ["echo"], limits: { maxTurns: 2 } },
		]),
	});
	const original = {
		taskKind: "demo",
		input: "hello",
		clientRequestId: "scoped-key",
		filters: { corpusTypes: ["internal"] },
		waitMs: 0,
	};
	const request = (path: string, token: string, value: unknown = original) =>
		secured.request(`http://local${path}`, {
			method: "POST",
			headers: {
				"x-internal-token": "test-only",
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(value),
		});
	try {
		expect([200, 202]).toContain((await request("/runs", java.token())).status);
		const found = await request("/runs/lookup", java.token({ grantId: "renewed" }));
		expect(found.status).toBe(200);
		expect(await found.json()).toMatchObject({ clientRequestId: "scoped-key" });
		expect((await request("/runs/lookup", java.token({ sub: "u2" }))).status).toBe(404);
		expect((await request("/runs/lookup", java.token({ tools: ["different"] }))).status).toBe(403);
		expect((await request("/runs/lookup", java.token(), { ...original, input: "changed" })).status).toBe(409);
	} finally {
		await localManager.shutdown();
		localStore.close();
	}
});
