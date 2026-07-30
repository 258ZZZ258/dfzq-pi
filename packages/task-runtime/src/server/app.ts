import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { SpecRouter } from "../router/router.ts";
import type { RunResult } from "../runtime/contract.ts";
import type { RunStore } from "../store/contract.ts";
import { checkInternalToken, INTERNAL_TOKEN_HEADER } from "./middleware/auth.ts";
import { clampWaitMs, validateSubmitBody } from "./middleware/validate.ts";
import { isTerminal, recordToRunResult } from "./routes.ts";
import type { RunManager } from "./run-manager.ts";

export interface AppOptions {
	manager: RunManager;
	router: SpecRouter;
	store: RunStore;
	/** 未配置 = 边界关闭(fail-closed)。 */
	internalToken: string | undefined;
	newSessionId?: () => string;
}

function errorBody(code: string, message: string) {
	return { error: { code, message } };
}

/** c.set/c.get 需要 Variables 泛型声明,否则 requestId 这一项过不了类型检查。 */
type AppEnv = { Variables: { requestId: string } };

export function createApp(options: AppOptions): Hono<AppEnv> {
	const { manager, router, store, internalToken } = options;
	const newSessionId = options.newSessionId ?? (() => randomUUID());
	const app = new Hono<AppEnv>();

	// 错误归一化:统一响应形状,绝不泄漏栈与内部文件路径(设计文档 §5.2-8)。
	app.onError((error, c) => {
		console.error(`[task-runtime] unhandled: ${error instanceof Error ? error.message : String(error)}`);
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
		await next();
	});

	app.post("/runs", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			// JSON 解析失败必须是 400,不能冒成 500。
			return c.json(errorBody("invalid_body", "request body is not valid JSON"), 400);
		}

		const validated = validateSubmitBody(raw);
		if (!validated.ok) {
			return c.json(errorBody(validated.error.code, validated.error.message), 422);
		}
		const body = validated.body;

		const spec = router.resolve(body.taskKind);
		if (!spec) {
			return c.json(errorBody("unknown_task_kind", `unknown taskKind "${body.taskKind}"`), 422);
		}

		const outcome = await manager.submit({
			taskKind: body.taskKind,
			specId: spec.id,
			input: body.input,
			clientRequestId: body.clientRequestId,
			requestId: body.requestId,
			sessionId: body.sessionId ?? newSessionId(),
			filtersJson: JSON.stringify(body.filters),
			optionsJson: body.options ? JSON.stringify(body.options) : undefined,
		});

		if (outcome.kind === "rejected") {
			if (outcome.rejection.kind === "session_busy") {
				return c.json(errorBody("session_busy", "this session already has a run in flight"), 409);
			}
			c.header("Retry-After", String(outcome.rejection.retryAfterSeconds));
			return c.json(errorBody("queue_full", "server is at capacity"), 503);
		}
		if (outcome.kind === "idempotent") {
			const row = store.findByRunId(outcome.runId);
			if (row && isTerminal(row.status)) return c.json(recordToRunResult(row), 200);
			return c.json({ runId: outcome.runId, status: outcome.status }, 202);
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
			const row = store.findByRunId(outcome.runId);
			if (row && isTerminal(row.status)) return c.json(recordToRunResult(row), 200);
			return c.json({ runId: outcome.runId, status: row?.status ?? "running" }, 202);
		}
		return c.json(raced as RunResult, 200);
	});

	app.get("/runs/:runId", (c) => {
		const row = store.findByRunId(c.req.param("runId"));
		if (!row) return c.json(errorBody("not_found", "run not found"), 404);
		if (!isTerminal(row.status)) return c.json({ runId: row.runId, status: row.status }, 200);
		return c.json(recordToRunResult(row), 200);
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
