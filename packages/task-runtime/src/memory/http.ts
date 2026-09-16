import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AuthorizationError, authorize, type Grant } from "../auth/grant.ts";
import type { MemoryEntry, MemoryInput, MemoryScope, MemoryService } from "./service.ts";

export function actorScope(tenant: string | undefined, user: string | undefined): MemoryScope | undefined {
	if (!tenant && !user) return undefined;
	if (!tenant || !user || tenant.length > 256 || user.length > 256) throw new Error("actor_context_invalid");
	return { tenantId: tenant, userId: user };
}
function publicEntry(entry: MemoryEntry) {
	const copy = { ...entry };
	delete copy.embedding;
	return copy;
}
export function createMemoryRoutes(memory: MemoryService, getGrant?: (context: Context) => Grant | undefined): Hono {
	const app = new Hono();
	app.use(
		"*",
		bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: "memory_body_too_large" } }, 413) }),
	);
	app.onError((error, c) => {
		if (error instanceof AuthorizationError) return c.json({ error: { code: error.message } }, error.status);
		const known = error.message.startsWith("memory_") || error.message.startsWith("actor_");
		return c.json(
			{ error: { code: known ? error.message : "memory_storage_error" } },
			known
				? error.message.includes("conflict") || error.message.includes("stale") || error.message.includes("not_")
					? 409
					: 422
				: 500,
		);
	});
	app.use("*", async (c, next) => {
		const grant = getGrant?.(c);
		if (grant) {
			const action =
				c.req.method === "GET"
					? "memory:read"
					: c.req.path.endsWith("/approve")
						? "memory:approve"
						: "memory:write";
			let sessionId: unknown = c.req.query("sessionId");
			if (c.req.method !== "GET") {
				try {
					sessionId = (await c.req.json<Record<string, unknown>>()).sessionId;
				} catch {
					return c.json({ error: { code: "malformed_json" } }, 400);
				}
			}
			authorize(grant, action, { sessionId: sessionId === undefined ? undefined : String(sessionId) });
		}
		try {
			if (!actorScope(c.req.header("x-tenant-id"), c.req.header("x-user-id")))
				return c.json({ error: { code: "actor_context_required" } }, 422);
		} catch {
			return c.json({ error: { code: "actor_context_invalid" } }, 422);
		}
		await next();
	});
	app.use("*", async (c, next) => {
		if (c.req.method !== "GET") {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: { code: "malformed_json" } }, 400);
			}
			if (!body || typeof body !== "object" || Array.isArray(body))
				return c.json({ error: { code: "memory_input_invalid" } }, 422);
		}
		await next();
	});
	const scopeFor = (tenant: string | undefined, user: string | undefined, sessionId: unknown): MemoryScope => {
		const scope = actorScope(tenant, user);
		if (!scope) throw new Error("actor_context_required");
		if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 256 || !sessionId))
			throw new Error("memory_scope_invalid");
		return { ...scope, ...(sessionId === undefined ? {} : { sessionId: sessionId as string }) };
	};
	app.get("/", async (c) => {
		const scope = scopeFor(c.req.header("x-tenant-id"), c.req.header("x-user-id"), c.req.query("sessionId"));
		const query = c.req.query("q");
		if (query && query.length > 4000) return c.json({ error: { code: "memory_query_too_long" } }, 422);
		const items = query === undefined ? await memory.list(scope) : await memory.retrieve(scope, query);
		return c.json({ version: 1, items: items.map(publicEntry) });
	});
	for (const path of ["/", "/proposals"] as const)
		app.post(path, async (c) => {
			const body = await c.req.json<Record<string, unknown>>();
			if (typeof body.requestId !== "string" || typeof body.text !== "string")
				return c.json({ error: { code: "memory_input_invalid" } }, 422);
			const scope = scopeFor(c.req.header("x-tenant-id"), c.req.header("x-user-id"), body.sessionId);
			const input: MemoryInput = {
				text: body.text,
				category: (body.category ?? "fact") as MemoryInput["category"],
				source: path === "/" ? "user" : "model",
				sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : "java-user",
				...(body.conflictKey === undefined ? {} : { conflictKey: body.conflictKey as string }),
				...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt as number }),
			};
			return c.json({ version: 1, item: publicEntry(await memory.propose(scope, input, body.requestId)) });
		});
	app.post("/compact", async (c) => {
		const body = await c.req.json<Record<string, unknown>>();
		if (
			!Array.isArray(body.ids) ||
			body.ids.length > 20 ||
			!body.ids.every((id) => typeof id === "string") ||
			typeof body.summary !== "string" ||
			typeof body.requestId !== "string"
		)
			return c.json({ error: { code: "memory_input_invalid" } }, 422);
		return c.json({
			version: 1,
			item: publicEntry(
				await memory.compact(
					scopeFor(c.req.header("x-tenant-id"), c.req.header("x-user-id"), body.sessionId),
					body.ids as string[],
					body.summary,
					body.requestId,
				),
			),
		});
	});
	app.post("/prune", async (c) => {
		const body = await c.req.json<Record<string, unknown>>();
		return c.json({
			removed: await memory.prune(
				scopeFor(c.req.header("x-tenant-id"), c.req.header("x-user-id"), body.sessionId),
				body.retentionMs as number | undefined,
			),
		});
	});
	for (const action of ["approve", "revise", "delete"] as const)
		app.post(`/:id/${action}`, async (c) => {
			const body = await c.req.json<Record<string, unknown>>();
			if (!Number.isInteger(body.revision) || Number(body.revision) < 1)
				return c.json({ error: { code: "memory_revision_required" } }, 422);
			const scope = scopeFor(c.req.header("x-tenant-id"), c.req.header("x-user-id"), body.sessionId);
			if (action === "delete") {
				await memory.remove(scope, c.req.param("id"), body.revision as number);
				return c.json({ deleted: true });
			}
			if (action === "revise" && typeof body.text !== "string")
				return c.json({ error: { code: "memory_input_invalid" } }, 422);
			const item =
				action === "approve"
					? await memory.approve(scope, c.req.param("id"), body.revision as number)
					: await memory.revise(
							scope,
							c.req.param("id"),
							body.revision as number,
							body.text as string,
							typeof body.sourceRef === "string" ? body.sourceRef : "java-user-edit",
						);
			return c.json({ version: 1, item: publicEntry(item) });
		});
	return app;
}
