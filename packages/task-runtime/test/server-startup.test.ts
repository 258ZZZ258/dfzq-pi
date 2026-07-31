import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/server/main.ts";
import * as sqliteModule from "../src/store/sqlite.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

const CASE_TIMEOUT_MS = 30_000;

let root: string;
let stop: (() => Promise<void>) | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-boot-"));
	const specs = join(root, "specs");
	await mkdir(specs);
	await writeFile(
		join(specs, "demo.json"),
		JSON.stringify({ id: "demo", model: { role: "main" }, toolset: "t", tools: ["a"], limits: { maxTurns: 3 } }),
	);
});

afterEach(async () => {
	// 必须显式 close():port 0 拿的是随机端口,不关就是残留监听。
	if (stop) await stop();
	stop = undefined;
	await rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("server startup", () => {
	it(
		"marks queued and running rows as error before accepting requests",
		async () => {
			const dbPath = join(root, "runs.db");
			const seed = createSqliteRunStore(dbPath);
			seed.insertQueued({
				runId: "stale-queued",
				clientRequestId: "c1",
				specId: "demo",
				taskKind: "demo",
				sessionId: "s1",
				filtersJson: "{}",
				input: "x",
				createdAt: 1,
			});
			seed.insertQueued({
				runId: "stale-running",
				clientRequestId: "c2",
				specId: "demo",
				taskKind: "demo",
				sessionId: "s2",
				filtersJson: "{}",
				input: "x",
				createdAt: 2,
			});
			seed.markRunning("stale-running", 3);
			seed.close();

			const server = await startServer({
				port: 0,
				dbPath,
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;

			const check = createSqliteRunStore(dbPath);
			for (const id of ["stale-queued", "stale-running"]) {
				expect(check.findByRunId(id)).toMatchObject({ status: "error", errorMessage: "process restarted" });
			}
			check.close();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"serves healthz on the bound port",
		async () => {
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;
			const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
				signal: AbortSignal.timeout(5_000),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, activeRuns: 0 });
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"serves the full submit/fetch/cancel cycle over a real socket",
		async () => {
			// ★ 其余 HTTP 用例走 app.request(),绕过 @hono/node-server 适配层与真实 socket。
			// 而出口判据说的是「Java 能发任务/取结果/取消」—— 那是真实 HTTP。适配层的接线 bug
			// (body 解析、header 大小写、状态码透传)只有这条用例能抓到。
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;
			const base = `http://127.0.0.1:${server.port}`;
			const headers = { "content-type": "application/json", "X-Internal-Token": "t" };

			// 发任务(header 名故意用混合大小写:HTTP 头大小写不敏感,适配层不该漏读)
			const submit = await fetch(`${base}/runs`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					taskKind: "demo",
					input: "问题",
					clientRequestId: "real-1",
					filters: { corpusTypes: ["internal"] },
					waitMs: 5000,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			expect(submit.status).toBe(200);
			const submitted = (await submit.json()) as { runId: string; status: string };
			expect(submitted.status).toBe("completed");

			// 取结果
			const fetched = await fetch(`${base}/runs/${submitted.runId}`, {
				headers: { "X-Internal-Token": "t" },
				signal: AbortSignal.timeout(5_000),
			});
			expect(fetched.status).toBe(200);
			expect(await fetched.json()).toMatchObject({ runId: submitted.runId, status: "completed" });

			// 取消已终态的 run → 409(证明错误路径的状态码也真的透出来了)
			const cancelled = await fetch(`${base}/runs/${submitted.runId}/cancel`, {
				method: "POST",
				headers: { "X-Internal-Token": "t" },
				signal: AbortSignal.timeout(5_000),
			});
			expect(cancelled.status).toBe(409);

			// 未带 token → 401(鉴权在真实链路上生效,不是只在 app.request() 里生效)
			const unauth = await fetch(`${base}/healthz`.replace("/healthz", "/runs/nope"), {
				signal: AbortSignal.timeout(5_000),
			});
			expect(unauth.status).toBe(401);
		},
		CASE_TIMEOUT_MS,
	);
});

// 以下用例来自评审对 main.ts 的复审(Critical + Important),补在 brief 逐字采用的
// describe("server startup", ...) 之外,不动上面那段。
describe("server shutdown safety", () => {
	it(
		"rejects instead of hanging forever when the port is already in use",
		async () => {
			// 先用裸 net server 占住一个端口,复现 EADDRINUSE ——这是唯一能让
			// @hono/node-server 的 serve() 触发 "error" 而不是 "listening" 的现实场景。
			const occupied = createServer();
			await new Promise<void>((resolve, reject) => {
				occupied.once("error", reject);
				occupied.listen(0, "127.0.0.1", () => resolve());
			});
			const occupiedAddress = occupied.address();
			if (typeof occupiedAddress !== "object" || !occupiedAddress) {
				throw new Error("failed to bind probe port");
			}
			const port = occupiedAddress.port;

			// 判别力护栏:若 startServer() 内部漏掉 once("error", reject),这个调用会一直
			// 挂到 CASE_TIMEOUT_MS 超时才被 vitest 判失败,而不是立刻拿到 EADDRINUSE——
			// 用全局 uncaughtException 兜底确认"不会崩进程",用 rejects 确认"确实响亮失败"。
			let uncaught: unknown;
			const onUncaughtException = (error: unknown) => {
				uncaught = error;
			};
			process.once("uncaughtException", onUncaughtException);

			try {
				await expect(
					startServer({
						port,
						dbPath: join(root, "runs.db"),
						specsDir: join(root, "specs"),
						internalToken: "t",
						runtimeFactory: async () => createStubRuntime(),
					}),
				).rejects.toThrow(/EADDRINUSE/);
			} finally {
				process.off("uncaughtException", onUncaughtException);
				await new Promise<void>((resolve) => occupied.close(() => resolve()));
			}

			expect(uncaught).toBeUndefined();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"close() is idempotent",
		async () => {
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			await server.close();
			// 第二次调用不该抛——close() 必须和 store.close()(见 store/sqlite.ts)同一条
			// "安全重入"纪律,否则调用方(以及测试的 afterEach)重复 close 一次就会撞
			// ERR_SERVER_NOT_RUNNING。
			await expect(server.close()).resolves.toBeUndefined();
			stop = server.close; // 第三次(afterEach 里)也不该抛,顺手验证幂等性不是"只对两次生效"。
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"warns instead of silently dropping results when closing with a run still in flight",
		async () => {
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime({ hang: true }),
			});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const submit = await fetch(`http://127.0.0.1:${server.port}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json", "X-Internal-Token": "t" },
				body: JSON.stringify({
					taskKind: "demo",
					input: "x",
					clientRequestId: "hang-1",
					filters: { corpusTypes: ["internal"] },
					waitMs: 50,
				}),
				signal: AbortSignal.timeout(5_000),
			});
			// hang 的 run 不会在 50ms 等待窗口内完成,竞速输给计时器,回 202 running。
			expect(submit.status).toBe(202);

			await server.close();
			stop = undefined; // 已经关过了,afterEach 不用再关一次

			expect(errorSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("still in flight"))).toBe(
				true,
			);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"runs recoverStaleRuns before the socket starts listening, not merely before startServer() resolves",
		async () => {
			// 只证明"port:0 场景下二者顺序恰好一致"证不了什么:recoverStaleRuns 是同步调用,
			// 只要仍在 return 之前,把它挪到 await serve(...) 之后,这个用例照样会通过——
			// 它只验证了"恢复早于 startServer() 返回",证不了"恢复早于 socket 开始监听"。
			// 用固定端口时二者的差别是真实风险(调用方可能在 resolve 前就抢先连上)。
			// 这里对 store.recoverStaleRuns 与 net.Server.prototype.listen 各插一个 spy,把
			// 触发顺序记进共享数组,直接断言调用序,不依赖网络竞速。
			const order: string[] = [];
			const originalCreate = sqliteModule.createSqliteRunStore;
			vi.spyOn(sqliteModule, "createSqliteRunStore").mockImplementation((path: string) => {
				const created = originalCreate(path);
				const originalRecover = created.recoverStaleRuns.bind(created);
				created.recoverStaleRuns = (now: number) => {
					order.push("recover");
					return originalRecover(now);
				};
				return created;
			});
			const originalListen = Server.prototype.listen as unknown as (...args: unknown[]) => Server;
			vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
				order.push("listen");
				return originalListen.apply(this, args);
			});

			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;

			expect(order.indexOf("recover")).toBeGreaterThanOrEqual(0);
			expect(order.indexOf("listen")).toBeGreaterThanOrEqual(0);
			expect(order.indexOf("recover")).toBeLessThan(order.indexOf("listen"));
		},
		CASE_TIMEOUT_MS,
	);
});
