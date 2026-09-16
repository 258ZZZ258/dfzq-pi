import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	type Action,
	AuthorizationError,
	authorize,
	constrainFilters,
	type Grant,
	type GrantVerifier,
	grantScopeHash,
	type Principal,
} from "../auth/grant.ts";
import type { InboxMessage, MessageInput } from "../interaction/inbox.ts";
import { actorScope, createMemoryRoutes } from "../memory/http.ts";
import type { MemoryScope, MemoryService } from "../memory/service.ts";
import type { SpecRouter } from "../router/router.ts";
import type { RunResult } from "../runtime/contract.ts";
import type { DocumentsClient } from "../runtime/policy-compare/documents-client.ts";
import { hashState } from "../state/json.ts";
import type { RunStore } from "../store/contract.ts";
import { checkInternalToken, INTERNAL_TOKEN_HEADER } from "./middleware/auth.ts";
import { clampWaitMs, validateSubmitBody } from "./middleware/validate.ts";
import { isTerminal, recordToRunResult, toWireResult } from "./routes.ts";
import type { RunManager, RunOptions } from "./run-manager.ts";

export interface AppOptions {
	grants?: GrantVerifier;
	memory?: MemoryService;
	manager: RunManager;
	router: SpecRouter;
	store: RunStore<boolean>;
	/** 未配置 = 边界关闭(fail-closed)。 */
	internalToken: string | undefined;
	newSessionId?: () => string;
	documents?: DocumentsClient;
}

function errorBody(code: string, message: string) {
	return { error: { code, message } };
}

/** c.set/c.get 需要 Variables 泛型声明,否则 requestId 这一项过不了类型检查。 */
type AppEnv = { Variables: { requestId: string; grant: Grant | undefined } };

const HOST_OPTIONS = [
	"resumeFrom",
	"memoryScope",
	"authorization",
	"conversation",
	"messageId",
	"interaction",
	"durableSession",
];

export function createApp(options: AppOptions): Hono<AppEnv> {
	const { manager, router, store, internalToken } = options;
	const newSessionId = options.newSessionId ?? (() => randomUUID());
	const app = new Hono<AppEnv>();

	// 错误归一化:统一响应形状,绝不泄漏栈与内部文件路径(设计文档 §5.2-8)。
	app.onError((error, c) => {
		if (/^authorization_[a-z_]+$/.test(error.message)) return c.json(errorBody(error.message, error.message), 409);
		if (error.message === "run_not_found") return c.json(errorBody("not_found", "run not found"), 404);
		if (error instanceof AuthorizationError) return c.json(errorBody(error.message, error.message), error.status);
		// 客户端 body 是刻意不透明的(不泄漏栈/内部路径)—— 这行 console.error 是 500 的
		// 唯一诊断信息。传整个 error 对象(而不是只拼 message)才能保住堆栈,与仓库既有
		// 风格一致(见 run-manager.ts 里同样传整个 error/markErrorFailure 对象的 console.error)。
		console.error("[task-runtime] unhandled:", error);
		return c.json(errorBody("internal_error", "internal error"), 500);
	});

	// requestId 贯穿全部日志。
	app.use("*", async (c, next) => {
		const requestId = c.req.header("x-request-id") ?? randomUUID();
		c.set("requestId", requestId);
		c.header("x-request-id", requestId);
		await next();
	});

	// healthz 不过鉴权 —— 探活不该依赖 token 配置是否就位。
	app.get("/healthz", (c) => c.json({ ok: true, activeRuns: manager.activeRuns, queueDepth: manager.queueDepth }));

	// 鉴权在最前(除 healthz),闸门在其之后 —— 未通过的请求不占并发额度(设计文档 §4.1)。
	app.use("*", async (c, next) => {
		const outcome = checkInternalToken(c.req.header(INTERNAL_TOKEN_HEADER), internalToken);
		if (outcome === "boundary_closed") {
			return c.json(errorBody("boundary_closed", "internal boundary is not configured"), 503);
		}
		if (outcome === "unauthorized") {
			return c.json(errorBody("unauthorized", "invalid internal token"), 401);
		}
		if (options.grants) {
			const authorization = c.req.header("authorization");
			if (!authorization?.startsWith("Bearer ")) throw new AuthorizationError("unauthorized");
			const grant = options.grants.verify(authorization.slice(7));
			c.set("grant", grant);
			// Existing memory adapter consumes these headers only after verification.
			c.req.raw.headers.set("x-tenant-id", grant.tenantId);
			c.req.raw.headers.set("x-user-id", grant.sub);
		}
		await next();
	});

	app.use(
		"*",
		bodyLimit({
			maxSize: 8 * 1024 * 1024,
			onError: (c) => c.json(errorBody("body_too_large", "request exceeds 8MiB"), 413),
		}),
	);
	for (const path of ["/runs/:runId", "/runs/:runId/*"])
		app.use(path, async (c, next) => {
			const runId = c.req.param("runId");
			if (!runId) return c.json(errorBody("not_found", "run not found"), 404);
			const row = await store.findByRunId(runId);
			const grant = c.get("grant");
			if (grant && row) {
				if (!row.principalJson) throw new AuthorizationError("forbidden");
				const suffix = c.req.path.split("/").at(-1);
				const action: Action =
					suffix === "authorization"
						? c.req.method === "DELETE"
							? "run:cancel"
							: "run:renew"
						: suffix === "cancel"
							? "run:cancel"
							: suffix === "resume"
								? "run:resume"
								: "run:read";
				authorize(grant, action, {
					sessionId: row.sessionId,
					taskKind: row.taskKind,
					principal: JSON.parse(row.principalJson) as Principal,
				});
				const original = row.optionsJson ? (JSON.parse(row.optionsJson) as RunOptions).authorization : undefined;
				if (action !== "run:cancel" && (!original || grantScopeHash(original) !== grantScopeHash(grant)))
					throw new AuthorizationError("forbidden");
			}
			const saved = row?.optionsJson ? (JSON.parse(row.optionsJson) as RunOptions).memoryScope : undefined;
			if (saved) {
				let actor: MemoryScope | undefined;
				try {
					actor = actorScope(c.req.header("x-tenant-id"), c.req.header("x-user-id"));
				} catch {
					return c.json(errorBody("forbidden", "actor mismatch"), 403);
				}
				if (!actor || actor.tenantId !== saved.tenantId || actor.userId !== saved.userId)
					return c.json(errorBody("forbidden", "actor mismatch"), 403);
			}
			await next();
		});
	if (options.memory)
		app.route(
			"/memories",
			createMemoryRoutes(options.memory, (context) => context.get("grant") as Grant | undefined),
		);
	app.get("/library/external-documents", async (c) => {
		const grant = c.get("grant");
		if (grant) authorize(grant, "library:read", {});
		if (grant && !grant.dataScope.corpusTypes.includes("external")) throw new AuthorizationError("forbidden");
		if (!options.documents?.listExternalDocuments)
			return c.json(errorBody("not_configured", "document library is not configured"), 503);
		const items = await options.documents.listExternalDocuments(
			grant
				? (constrainFilters(grant, { corpusTypes: grant.dataScope.corpusTypes, permTags: c.req.queries("permTag") })
						.permTags ?? [])
				: (c.req.queries("permTag") ?? []),
			c.req.query("includeHistory") === "true" && (!grant || grant.dataScope.includeSuperseded === true),
		);
		return c.json(items);
	});

	app.get("/library/internal-documents", async (c) => {
		const grant = c.get("grant");
		if (grant) authorize(grant, "library:read", {});
		if (grant && !grant.dataScope.corpusTypes.includes("internal")) throw new AuthorizationError("forbidden");
		if (!options.documents?.listInternalDocuments)
			return c.json(errorBody("not_configured", "document library is not configured"), 503);
		const items = await options.documents.listInternalDocuments(
			grant
				? (constrainFilters(grant, { corpusTypes: grant.dataScope.corpusTypes, permTags: c.req.queries("permTag") })
						.permTags ?? [])
				: (c.req.queries("permTag") ?? []),
			c.req.query("includeHistory") === "true" && (!grant || grant.dataScope.includeSuperseded === true),
		);
		return c.json(items);
	});

	// Read-only reconciliation: never call manager.submit, even when the key is absent.
	app.post("/runs/lookup", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(errorBody("malformed_json", "request body is not valid JSON"), 400);
		}
		const validated = validateSubmitBody(raw);
		if (!validated.ok) return c.json(errorBody(validated.error.code, validated.error.message), 422);
		const body = validated.body;
		if (body.options && HOST_OPTIONS.some((key) => key in body.options!))
			return c.json(errorBody("reserved_option", "host controlled options are not accepted"), 422);
		const grant = c.get("grant");
		const requestKey = grant ? hashState([grant.tenantId, grant.sub, body.clientRequestId]) : body.clientRequestId;
		const row = await store.findByClientRequestId(requestKey);
		if (!row) return c.json(errorBody("not_found", "run not found; absence does not authorize resubmission"), 404);
		const storedOptions = JSON.parse(row.optionsJson ?? "{}") as RunOptions;
		if (grant) {
			if (!row.principalJson || !storedOptions.authorization) throw new AuthorizationError("forbidden");
			authorize(grant, "run:read", {
				sessionId: row.sessionId,
				taskKind: row.taskKind,
				principal: JSON.parse(row.principalJson) as Principal,
			});
			if (grantScopeHash(grant) !== grantScopeHash(storedOptions.authorization))
				throw new AuthorizationError("forbidden");
		}
		if (storedOptions.memoryScope) {
			const actor = actorScope(c.req.header("x-tenant-id"), c.req.header("x-user-id"));
			if (
				!actor ||
				actor.tenantId !== storedOptions.memoryScope.tenantId ||
				actor.userId !== storedOptions.memoryScope.userId
			)
				throw new AuthorizationError("forbidden");
		}
		const clientOptions: Record<string, unknown> = { ...storedOptions };
		for (const key of HOST_OPTIONS) delete clientOptions[key];
		const requestedOptions = {
			...body.options,
			...(grant
				? {
						includeSuperseded:
							body.options?.includeSuperseded === true && grant.dataScope.includeSuperseded === true,
					}
				: {}),
		};
		const equal =
			row.taskKind === body.taskKind &&
			(row.sessionIdExplicit ?? true) === (body.sessionId !== undefined) &&
			(body.sessionId === undefined || row.sessionId === body.sessionId) &&
			row.input === body.input &&
			isDeepStrictEqual(JSON.parse(row.filtersJson), grant ? constrainFilters(grant, body.filters) : body.filters) &&
			isDeepStrictEqual(clientOptions, requestedOptions) &&
			isDeepStrictEqual(row.payloadJson === undefined ? undefined : JSON.parse(row.payloadJson), body.payload);
		if (!equal)
			return c.json(
				errorBody("request_conflict", "request key belongs to different input or authorization scope"),
				409,
			);
		return c.json({ runId: row.runId, status: row.status, clientRequestId: body.clientRequestId }, 200);
	});

	app.post("/runs", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			// JSON 解析失败必须是 400,不能冒成 500。专用 code(而不是复用下面 422 schema
			// 校验的 invalid_body):Java 一旦上线,"400 JSON 解析失败"与"422 schema 不合法"
			// 是两类不同的客户端错误,现在分开成本是一行,上线后再分开就是破坏性变更。
			return c.json(errorBody("malformed_json", "request body is not valid JSON"), 400);
		}

		const validated = validateSubmitBody(raw);
		if (!validated.ok) {
			return c.json(errorBody(validated.error.code, validated.error.message), 422);
		}
		const body = validated.body;
		if (body.options && HOST_OPTIONS.some((key) => key in body.options!))
			return c.json(errorBody("reserved_option", "resumeFrom and memoryScope are host controlled"), 422);
		let actor: MemoryScope | undefined;
		try {
			actor = actorScope(c.req.header("x-tenant-id"), c.req.header("x-user-id"));
		} catch {
			return c.json(errorBody("actor_context_invalid", "both actor headers are required"), 422);
		}

		const spec = router.resolve(body.taskKind);
		if (!spec) {
			return c.json(errorBody("unknown_task_kind", `unknown taskKind "${body.taskKind}"`), 422);
		}
		const grant = c.get("grant");
		const sessionId = body.sessionId ?? grant?.sessionId ?? newSessionId();
		if (grant) authorize(grant, "run:create", { sessionId, taskKind: body.taskKind });
		const runOptions = {
			durableSession: spec.durableSession !== false && !spec.workflow,
			interaction: Boolean(grant && manager.supportsMessages && !spec.workflow && spec.durableSession !== false),
			...body.options,
			...(grant
				? {
						authorization: grant,
						includeSuperseded:
							body.options?.includeSuperseded === true && grant.dataScope.includeSuperseded === true,
					}
				: {}),
		};

		const outcome = await manager.submit({
			principal: grant ? { tenantId: grant.tenantId, userId: grant.sub } : undefined,
			taskKind: body.taskKind,
			specId: spec.id,
			input: body.input,
			clientRequestId: body.clientRequestId,
			requestId: body.requestId,
			sessionId,
			sessionIdExplicit: body.sessionId !== undefined,
			// 结构化下传,**原样**:序列化归 RunManager(它同时要落库和透给工厂,两处只能有一份
			// 口径)。这里不补任何默认值 —— filters_json 是事后审计「这个 run 当时被授权了什么」
			// 的唯一凭证,补默认值会让存档与 Java 发来的请求体对不上。形状已由 validateSubmitBody 校验。
			filters: grant ? constrainFilters(grant, body.filters) : body.filters,
			// SubmitBodySchema 把 options 声明成 Record<string, unknown>,比 RunOptions 宽。
			// 不为此收窄 schema —— options 是给下游 audit-ai 的透传位,收窄会让将来加一个
			// 查询层字段变成一次 HTTP 层改动。
			options: actor ? ({ ...runOptions, memoryScope: actor } as RunOptions) : (runOptions as RunOptions),
			// 与 filters 同款:**原样**下传,不补默认值 —— payload_json 是事后审计
			// 「这个 run 当时拿到的任务输入是什么」的唯一凭证。
			payload: body.payload,
		});

		if (outcome.kind === "idempotency_conflict") {
			return c.json(
				errorBody("idempotency_conflict", "clientRequestId was already used with different request content"),
				409,
			);
		}
		if (outcome.kind === "rejected") {
			if (outcome.rejection.kind === "session_busy") {
				return c.json(errorBody("session_busy", "this session already has a run in flight"), 409);
			}
			c.header("Retry-After", String(outcome.rejection.retryAfterSeconds));
			return c.json(errorBody("queue_full", "server is at capacity"), 503);
		}
		if (outcome.kind === "idempotent") {
			const row = await manager.findRun(outcome.runId);
			if (row && isTerminal(row.status)) return c.json(toWireResult(recordToRunResult(row)), 200);
			// row?.status 而不是 outcome.status(创建时的快照):markError/markRunning 等落库
			// 写入若失败,drive() 的 finally 仍会无条件 live.delete,行却可能停在非终态 ——
			// 「行非终态且不在 live」因此是可达的(finding #2 之后),不能再假设这里必是
			// outcome 创建时那个状态。row 理论上不该是 undefined(idempotent 分支的行必然已由
			// insertQueued 写入过),但仍以 outcome.status 兜底,不让这里因为 store 读失败而炸。
			return c.json({ runId: outcome.runId, status: row?.status ?? outcome.status }, 202);
		}

		// 等待窗口。超时只影响本次响应,run 继续在后台推进(设计文档 §6.4.2)。
		const timeout = Symbol("timeout");
		let timer: NodeJS.Timeout | undefined;
		const raced = await Promise.race([
			// 后台 promise 的 rejection 由 RunManager.drive 落库处理;这里吞掉以免变成
			// unhandledRejection —— 转 202 后没人再 await 它。
			outcome.completion.catch(() => timeout),
			new Promise<typeof timeout>((resolve) => {
				timer = setTimeout(() => resolve(timeout), clampWaitMs(body.waitMs));
			}),
		]);
		if (timer) clearTimeout(timer);

		if (raced === timeout) {
			// 竞速输了不代表还在跑:装配失败的 completion 会 reject 并被上面的 catch 吞成
			// timeout 信号,而此时行已落库为 error(终态)。以 store 当前状态为准 ——
			// 终态直接回 200 结果(含 error),非终态回 202 并如实报 queued/running
			// (排队中的 run 不许谎称 running,RunManager 的 queued 语义就是为此服务的)。
			const row = await manager.findRun(outcome.runId);
			if (row && isTerminal(row.status)) return c.json(toWireResult(recordToRunResult(row)), 200);
			return c.json({ runId: outcome.runId, status: row?.status ?? "running" }, 202);
		}
		return c.json(toWireResult(raced as RunResult), 200);
	});

	app.get("/runs/:runId", async (c) => {
		const row = await manager.findRun(c.req.param("runId"));
		if (!row) return c.json(errorBody("not_found", "run not found"), 404);
		// isTerminal 判定必须先于 progress —— 一个已经落库为终态的行不该再挂 progress 字段
		// (规格 §7.2:progress 只描述「正在跑」这件事;终态的真相是下面的 RunResult)。
		if (!isTerminal(row.status)) {
			const progress = manager.progressOf(row.runId);
			// 三元而非无条件展开:没有 progress 时响应体里根本不该出现这个键,不是「键在、值
			// undefined」——两者在 JSON 线上不可区分,但代码语义不该暧昧(见测试里的同款纪律)。
			return c.json(
				progress ? { runId: row.runId, status: row.status, progress } : { runId: row.runId, status: row.status },
				200,
			);
		}
		return c.json(toWireResult(recordToRunResult(row)), 200);
	});

	app.post("/runs/:runId/resume", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(errorBody("malformed_json", "request body is not valid JSON"), 400);
		}
		const key = raw && typeof raw === "object" ? (raw as { clientRequestId?: unknown }).clientRequestId : undefined;
		if (
			typeof key !== "string" ||
			key.length === 0 ||
			key.length > 256 ||
			Object.keys(raw as object).some((name) => name !== "clientRequestId")
		)
			return c.json(errorBody("invalid_body", "only clientRequestId is accepted"), 422);
		const outcome = await manager.resume(c.req.param("runId"), key, c.get("grant"));
		if (outcome.kind === "not_found") return c.json(errorBody("not_found", "run not found"), 404);
		if (outcome.kind === "not_resumable")
			return c.json(errorBody("not_resumable", "durable resume is not configured or run is completed"), 409);
		if (outcome.kind === "idempotency_conflict")
			return c.json(errorBody("idempotency_conflict", "resume request key was reused"), 409);
		if (outcome.kind === "rejected") {
			if (outcome.rejection.kind === "session_busy")
				return c.json(errorBody("session_busy", "session is busy"), 409);
			c.header("Retry-After", String(outcome.rejection.retryAfterSeconds));
			return c.json(errorBody("queue_full", "resume admission rejected"), 503);
		}
		if (outcome.kind === "accepted") void outcome.completion.catch(() => {});
		const row = await manager.findRun(outcome.runId);
		if (row && isTerminal(row.status))
			return c.json({ ...toWireResult(recordToRunResult(row)), resumedFrom: c.req.param("runId") }, 200);
		return c.json({ runId: outcome.runId, resumedFrom: c.req.param("runId"), status: row?.status ?? "queued" }, 202);
	});

	app.post("/runs/:runId/authorization", async (c) => {
		const grant = c.get("grant");
		if (!grant) throw new AuthorizationError("unauthorized");
		await manager.updateAuthorization(c.req.param("runId"), grant);
		return c.json({ renewed: true, expiresAt: grant.exp * 1000 });
	});
	app.delete("/runs/:runId/authorization", async (c) => {
		const grant = c.get("grant");
		if (!grant) throw new AuthorizationError("unauthorized");
		await manager.updateAuthorization(c.req.param("runId"), grant, true);
		return c.json({ revoked: true }, 202);
	});
	const messageView = (message: InboxMessage) => ({
		messageId: message.messageId,
		clientMessageId: message.clientMessageId,
		kind: message.kind,
		sequence: message.sequence,
		status: message.status,
		text: message.text,
		targetRunId: message.targetRunId,
		afterRunId: message.afterRunId,
		runId: message.runId,
		consumedCheckpointSeq: message.consumedCheckpointSeq,
		error: message.error,
	});
	app.post("/sessions/:sessionId/messages", async (c) => {
		const grant = c.get("grant");
		if (!grant) throw new AuthorizationError("unauthorized");
		if (!manager.supportsMessages)
			return c.json(errorBody("messages_not_configured", "persistent inbox required"), 503);
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(errorBody("malformed_json", "invalid JSON"), 400);
		}
		if (
			!raw ||
			typeof raw !== "object" ||
			Array.isArray(raw) ||
			Object.keys(raw).some((key) => !["clientMessageId", "kind", "targetRunId", "afterRunId", "text"].includes(key))
		)
			return c.json(errorBody("message_invalid", "invalid message"), 422);
		const input = raw as MessageInput;
		if (
			!["steer", "follow_up"].includes(input.kind) ||
			typeof input.clientMessageId !== "string" ||
			typeof input.text !== "string" ||
			(input.targetRunId !== undefined && typeof input.targetRunId !== "string") ||
			(input.afterRunId !== undefined && typeof input.afterRunId !== "string")
		)
			return c.json(errorBody("message_invalid", "invalid message"), 422);
		authorize(grant, input.kind === "steer" ? "run:steer" : "run:follow_up", { sessionId: c.req.param("sessionId") });
		try {
			return c.json(messageView(await manager.enqueueMessage(grant, input)), 202);
		} catch (error) {
			if (error instanceof AuthorizationError) throw error;
			const code = error instanceof Error ? error.message : "message_failed";
			return c.json(
				errorBody(code, code),
				code === "message_queue_full" ? 429 : code === "message_invalid" ? 422 : 409,
			);
		}
	});
	app.get("/sessions/:sessionId/messages", async (c) => {
		if (!manager.supportsMessages)
			return c.json(errorBody("messages_not_configured", "persistent inbox required"), 503);
		const grant = c.get("grant");
		if (!grant) throw new AuthorizationError("unauthorized");
		authorize(grant, "run:read", { sessionId: c.req.param("sessionId") });
		const after = Number(c.req.query("afterSequence") ?? 0);
		if (!Number.isSafeInteger(after) || after < 0) return c.json(errorBody("invalid_cursor", "invalid cursor"), 422);
		const items = (await manager.listMessages(grant))
			.filter((m) => m.sequence > after && grantScopeHash(m.grant) === grantScopeHash(grant))
			.slice(0, 50)
			.map(messageView);
		return c.json({ items, nextSequence: items.at(-1)?.sequence ?? after });
	});
	app.post("/runs/:runId/cancel", async (c) => {
		const outcome = await manager.cancel(c.req.param("runId"));
		if (outcome === "accepted") return c.body(null, 202);
		if (outcome === "already_terminal") {
			return c.json(errorBody("already_terminal", "run has already finished"), 409);
		}
		return c.json(errorBody("not_found", "run not found"), 404);
	});

	return app;
}
