import { expect, it, vi } from "vitest";
import { GrantLease } from "../src/auth/lease.ts";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { withDurableExecution } from "../src/state/durable-factory.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { javaGrantFixture } from "./helpers/java-grant.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

it("revokes a queued job before any worker has created its grant lease", async () => {
	const store = createSqliteStateStore(":memory:"),
		leases = new GrantLease(store),
		grant = javaGrantFixture().claims;
	try {
		await leases.revoke("queued", grant);
		await expect(leases.renew("queued", grant)).rejects.toThrow("authorization_revoked");
	} finally {
		await store.close();
	}
});

it("renews same-scope verified grants, rejects scope changes, and keeps revocation sticky", async () => {
	const store = createSqliteStateStore(":memory:"),
		leases = new GrantLease(store),
		grant = javaGrantFixture().claims;
	try {
		await leases.renew("r", grant);
		await leases.renew("r", { ...grant, grantId: "g2", exp: grant.exp + 10 });
		expect((await leases.current("r", grant)).grantId).toBe("g2");
		await expect(leases.renew("r", { ...grant, policyVersion: "2" })).rejects.toThrow("authorization_scope_changed");
		await leases.revoke("r", grant);
		await expect(leases.current("r", grant)).rejects.toThrow("authorization_revoked");
		await expect(leases.renew("r", { ...grant, exp: grant.exp + 30 })).rejects.toThrow("authorization_revoked");
	} finally {
		await store.close();
		vi.restoreAllMocks();
	}
});

it.each(["renew", "revoke"] as const)("the active host observes %s before publishing a result", async (mode) => {
	const store = createSqliteStateStore(":memory:"),
		leases = new GrantLease(store),
		grant = javaGrantFixture().claims;
	const start = grant.iat * 1000;
	const clock = vi.spyOn(Date, "now").mockReturnValue(start);
	grant.exp = grant.iat + 1;
	const stub = createStubRuntime({ hang: true }),
		factory = withDurableExecution(async () => stub, new CheckpointCoordinator(store), "cfg");
	const runtime = await factory({
		specId: "demo",
		runId: "r",
		sessionId: "s1",
		initialInput: "q",
		filters: { corpusTypes: ["internal"] },
		options: { authorization: grant },
	});
	try {
		const done = runtime.run("q", { runId: "r" });
		void done.catch(() => {});
		await expect.poll(() => stub.runCalls).toBe(1);
		if (mode === "renew") await leases.renew("r", { ...grant, exp: grant.iat + 100, grantId: "g2" });
		else await leases.revoke("r", grant);
		clock.mockReturnValue(start + 2000);
		stub.resolveNow();
		if (mode === "renew") expect((await done).status).toBe("completed");
		else await expect(done).rejects.toThrow("authorization_revoked");
	} finally {
		await runtime.dispose();
		await factory.close?.();
		await store.close();
		vi.restoreAllMocks();
	}
});
