import { expect, it } from "vitest";
import { grantScopeHash } from "../src/auth/grant.ts";

it("keeps accepted steering across execution failure and consumes it only on the same root job resume", async () => {
	const store = createSqliteStateStore(":memory:"),
		inbox = new SessionInbox(store),
		grant = javaGrantFixture().claims;
	try {
		await inbox.begin(grant, "r1", "r1");
		const message = await inbox.enqueue(grant, {
			kind: "steer",
			targetRunId: "r1",
			clientMessageId: "pending",
			text: "must survive",
		});
		await inbox.finish(grant, "r1", "error");
		await inbox.begin(grant, "unrelated", "unrelated");
		expect(await inbox.pendingSteers(grant, "unrelated", [])).toEqual([]);
		await inbox.finish(grant, "unrelated", "completed");
		await inbox.begin(grant, "r2", "r1");
		expect((await inbox.pendingSteers(grant, "r1", [])).map((m) => m.messageId)).toEqual([message.messageId]);
	} finally {
		await store.close();
	}
});

import { SessionInbox } from "../src/interaction/inbox.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { javaGrantFixture } from "./helpers/java-grant.ts";

it("persists ordered idempotent messages and distinguishes accepted from consumed", async () => {
	const store = createSqliteStateStore(":memory:"),
		inbox = new SessionInbox(store),
		grant = javaGrantFixture().claims;
	try {
		await inbox.begin(grant, "run1", "run1");
		const input = { clientMessageId: "m1", kind: "steer" as const, targetRunId: "run1", text: "change direction" };
		const first = await inbox.enqueue(grant, input);
		expect(await inbox.enqueue(grant, input)).toEqual(first);
		await expect(inbox.enqueue(grant, { ...input, text: "different" })).rejects.toThrow("message_conflict");
		expect((await new SessionInbox(store).pendingSteers(grant, "run1", [])).map((m) => m.messageId)).toEqual([
			first.messageId,
		]);
		expect(await inbox.seal(grant, "run1")).toBe(false);
		await inbox.acknowledge(grant, "run1", [first.messageId], 3);
		expect(await inbox.seal(grant, "run1")).toBe(true);
		await expect(inbox.enqueue(grant, { ...input, clientMessageId: "late" })).rejects.toThrow("run_not_active");
		expect((await inbox.messages(grant))[0]).toMatchObject({ status: "consumed", consumedCheckpointSeq: 3 });
	} finally {
		await store.close();
	}
});
it("allows one owner to claim a follow-up and preserves the fixed input across retry", async () => {
	const store = createSqliteStateStore(":memory:"),
		inbox = new SessionInbox(store),
		grant = javaGrantFixture().claims;
	try {
		await inbox.begin(grant, "r", "r");
		await inbox.enqueue(grant, { clientMessageId: "f", kind: "follow_up", afterRunId: "r", text: "next" });
		await inbox.finish(grant, "r", "completed", {
			version: 1,
			messages: [{ role: "user", content: "original" }],
			scopeHash: grantScopeHash(grant),
			memoryRefs: [],
		});
		const a = await inbox.claimFollowUp(grant, "hostA");
		expect(a?.text).toBe("next");
		expect(await inbox.claimFollowUp(grant, "hostB")).toBeUndefined();
	} finally {
		await store.close();
	}
});
