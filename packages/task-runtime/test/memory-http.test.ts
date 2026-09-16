import { Hono } from "hono";
import { expect, it } from "vitest";
import { createMemoryRoutes } from "../src/memory/http.ts";
import { MemoryService } from "../src/memory/service.ts";
import { createSqliteStateStore } from "../src/state/store.ts";

it("serves actor-scoped candidate approval and deletion with revision checks", async () => {
	const store = createSqliteStateStore(":memory:");
	const app = new Hono().route("/memories", createMemoryRoutes(new MemoryService(store)));
	const headers = { "content-type": "application/json", "x-tenant-id": "t", "x-user-id": "u" };
	try {
		const response = await app.request("/memories/proposals", {
			method: "POST",
			headers,
			body: JSON.stringify({ requestId: "p", text: "喜欢中文简洁回答", category: "preference" }),
		});
		const body = (await response.json()) as { item: { id: string; revision: number; status: string } };
		expect(body.item.status).toBe("candidate");
		expect(await (await app.request("/memories?q=中文", { headers })).json()).toMatchObject({ items: [] });
		const approved = (await (
			await app.request(`/memories/${body.item.id}/approve`, {
				method: "POST",
				headers,
				body: JSON.stringify({ revision: 1 }),
			})
		).json()) as typeof body;
		expect(approved.item.status).toBe("active");
		expect(
			await (await app.request("/memories?q=中文", { headers: { ...headers, "x-user-id": "other" } })).json(),
		).toMatchObject({ items: [] });
		expect(
			(
				await app.request(`/memories/${body.item.id}/delete`, {
					method: "POST",
					headers,
					body: JSON.stringify({ revision: 1 }),
				})
			).status,
		).toBe(409);
		expect(
			(
				await app.request(`/memories/${body.item.id}/delete`, {
					method: "POST",
					headers,
					body: JSON.stringify({ revision: approved.item.revision }),
				})
			).status,
		).toBe(200);
		expect(await (await app.request("/memories?q=中文", { headers })).json()).toMatchObject({ items: [] });
		expect((await app.request("/memories", { headers: {} })).status).toBe(422);
		expect((await app.request("/memories", { method: "POST", headers, body: "null" })).status).toBe(422);
	} finally {
		await store.close();
	}
});
