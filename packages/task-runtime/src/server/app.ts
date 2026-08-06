import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { SpecRouter } from "../router/router.ts";
import type { RunResult } from "../runtime/contract.ts";
import type { RunStore } from "../store/contract.ts";
import { checkInternalToken, INTERNAL_TOKEN_HEADER } from "./middleware/auth.ts";
import { clampWaitMs, validateSubmitBody } from "./middleware/validate.ts";
import { isTerminal, recordToRunResult, toWireResult } from "./routes.ts";
import type { RunManager, RunOptions } from "./run-manager.ts";

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
		await next();
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
			// 结构化下传,**原样**:序列化归 RunManager(它同时要落库和透给工厂,两处只能有一份
			// 口径)。这里不补任何默认值 —— filters_json 是事后审计「这个 run 当时被授权了什么」
			// 的唯一凭证,补默认值会让存档与 Java 发来的请求体对不上。形状已由 validateSubmitBody 校验。
			filters: body.filters,
			// SubmitBodySchema 把 options 声明成 Record<string, unknown>,比 RunOptions 宽。
			// 不为此收窄 schema —— options 是给下游 audit-ai 的透传位,收窄会让将来加一个
			// 查询层字段变成一次 HTTP 层改动。
			options: body.options as RunOptions | undefined,
			// 与 filters 同款:**原样**下传,不补默认值 —— payload_json 是事后审计
			// 「这个 run 当时拿到的任务输入是什么」的唯一凭证。
			payload: body.payload,
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
			const row = store.findByRunId(outcome.runId);
			if (row && isTerminal(row.status)) return c.json(toWireResult(recordToRunResult(row)), 200);
			return c.json({ runId: outcome.runId, status: row?.status ?? "running" }, 202);
		}
		return c.json(toWireResult(raced as RunResult), 200);
	});

	app.get("/runs/:runId", (c) => {
		const row = store.findByRunId(c.req.param("runId"));
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
