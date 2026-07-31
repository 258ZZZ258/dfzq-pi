import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server/main.ts";
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
