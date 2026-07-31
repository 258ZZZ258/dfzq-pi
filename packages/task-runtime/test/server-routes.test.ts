import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecRouter } from "../src/router/router.ts";
import { createApp } from "../src/server/app.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager } from "../src/server/run-manager.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import type { RunStore } from "../src/store/contract.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime, type StubRuntime, type StubRuntimeOptions } from "./helpers/stub-runtime.ts";

const TOKEN = "internal-secret";
const SPEC: RuntimeSpec = {
	id: "demo",
	model: { role: "main" },
	toolset: "t",
	tools: ["a"],
	limits: { maxTurns: 3 },
};

let root: string;
let store: RunStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-http-"));
	store = createSqliteRunStore(join(root, "runs.db"));
});

afterEach(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

function app(stubOptions: StubRuntimeOptions = {}, ...tokenArgs: Array<string | undefined>) {
	// rest 参数而非默认参数:JS 的默认参数在「省略实参」和「显式传 undefined」两种情况下
	// 都会触发替换,无法区分 —— 而本文件里既有依赖省略走默认 TOKEN 的调用点,也有故意显式
	// 传 undefined 来表达「服务端未配置 token」的用例(boundary_closed)。rest 参数的
	// length 能精确分辨这两种情况。
	const token = tokenArgs.length > 0 ? tokenArgs[0] : TOKEN;
	const stub = createStubRuntime(stubOptions);
	const manager = new RunManager({
		store,
		gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 1, retryAfterSeconds: 3 }),
		runtimeFactory: async () => stub,
	});
	return { hono: createApp({ manager, router: new SpecRouter([SPEC]), store, internalToken: token }), stub };
}

function post(body: unknown, ...tokenArgs: Array<string | undefined>): Request {
	// 同上:rest 参数区分「省略」与「显式 undefined」,详见 app() 的注释。
	const token = tokenArgs.length > 0 ? tokenArgs[0] : TOKEN;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers["x-internal-token"] = token;
	return new Request("http://local/runs", { method: "POST", headers, body: JSON.stringify(body) });
}

function submitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		taskKind: "demo",
		input: "问题",
		clientRequestId: `cli-${Math.random()}`,
		filters: { corpusTypes: ["internal"] },
		...overrides,
	};
}

describe("POST /runs", () => {
	it("returns 200 with the RunResult when the run finishes inside the window", async () => {
		const { hono } = app();
		const res = await hono.request(post(submitBody({ waitMs: 5000 })));
		expect(res.status).toBe(200);
		const json = (await res.json()) as { status: string; output: string; runId: string };
		expect(json.status).toBe("completed");
		expect(json.output).toBe("stub output");
	});

	it("returns 202 when the window expires, and the run still finishes and persists", async () => {
		const { hono, stub } = app({ hang: true });
		const res = await hono.request(post(submitBody({ waitMs: 0 })));
		expect(res.status).toBe(202);
		const json = (await res.json()) as { runId: string; status: string };
		expect(json.status).toBe("running");

		stub.resolveNow();
		// 后台 run 不因 202 中断
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(store.findByRunId(json.runId)?.status).toBe("completed");
	});

	it("returns 409 for a concurrent run on the same session", async () => {
		const { hono, stub } = app({ hang: true });
		const first = await hono.request(post(submitBody({ sessionId: "s1", waitMs: 0 })));
		expect(first.status).toBe(202);
		const second = await hono.request(post(submitBody({ sessionId: "s1", waitMs: 0 })));
		expect(second.status).toBe(409);
		stub.resolveNow();
	});

	it("returns 422 when filters is missing", async () => {
		const { hono } = app();
		const body = submitBody();
		delete body.filters;
		const res = await hono.request(post(body));
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({ error: { code: "missing_authorization_scope" } });
	});

	it("returns 422 when corpusTypes is empty", async () => {
		const { hono } = app();
		const res = await hono.request(post(submitBody({ filters: { corpusTypes: [] } })));
		expect(res.status).toBe(422);
	});

	it("returns 422 for an unknown taskKind", async () => {
		const { hono } = app();
		const res = await hono.request(post(submitBody({ taskKind: "nope" })));
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({ error: { code: "unknown_task_kind" } });
	});

	it("returns 400 for malformed JSON, with a dedicated code distinct from schema-validation's invalid_body", async () => {
		const { hono } = app();
		const res = await hono.request(
			new Request("http://local/runs", {
				method: "POST",
				headers: { "content-type": "application/json", "x-internal-token": TOKEN },
				body: "{not json",
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "malformed_json" } });
	});

	it("returns the same runId for a repeated clientRequestId", async () => {
		const { hono, stub } = app();
		const body = submitBody({ waitMs: 5000 });
		const first = (await (await hono.request(post(body))).json()) as { runId: string };
		const second = (await (await hono.request(post(body))).json()) as { runId: string };
		expect(second.runId).toBe(first.runId);
		expect(stub.runCalls).toBe(1);
	});

	it("stores filters verbatim", async () => {
		const { hono } = app();
		const filters = { permTags: ["内部"], corpusTypes: ["internal"], projectId: null };
		const res = await hono.request(post(submitBody({ filters, waitMs: 5000 })));
		const { runId } = (await res.json()) as { runId: string };
		expect(JSON.parse(store.findByRunId(runId)?.filtersJson ?? "{}")).toEqual(filters);
	});
});

describe("auth", () => {
	it("returns 503 boundary_closed when the server token is unset", async () => {
		const { hono } = app({}, undefined);
		const res = await hono.request(post(submitBody(), "whatever"));
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ error: { code: "boundary_closed" } });
	});

	it("returns 401 without the header", async () => {
		const { hono } = app();
		const res = await hono.request(post(submitBody(), undefined));
		expect(res.status).toBe(401);
	});

	it("leaves /healthz open", async () => {
		const { hono } = app();
		const res = await hono.request(new Request("http://local/healthz"));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
	});
});

describe("GET /runs/{runId}", () => {
	it("returns the terminal RunResult", async () => {
		const { hono } = app();
		const { runId } = (await (await hono.request(post(submitBody({ waitMs: 5000 })))).json()) as { runId: string };
		const res = await hono.request(
			new Request(`http://local/runs/${runId}`, { headers: { "x-internal-token": TOKEN } }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ runId, status: "completed", output: "stub output" });
	});

	it("returns running for an in-flight run", async () => {
		const { hono, stub } = app({ hang: true });
		const { runId } = (await (await hono.request(post(submitBody({ waitMs: 0 })))).json()) as { runId: string };
		const res = await hono.request(
			new Request(`http://local/runs/${runId}`, { headers: { "x-internal-token": TOKEN } }),
		);
		expect(await res.json()).toMatchObject({ runId, status: "running" });
		stub.resolveNow();
	});

	it("returns 404 for an unknown runId", async () => {
		const { hono } = app();
		const res = await hono.request(new Request("http://local/runs/nope", { headers: { "x-internal-token": TOKEN } }));
		expect(res.status).toBe(404);
	});
});

describe("POST /runs/{runId}/cancel", () => {
	it("returns 202 and aborts a running run", async () => {
		const { hono, stub } = app({ hang: true, result: { status: "aborted" } });
		const { runId } = (await (await hono.request(post(submitBody({ waitMs: 0 })))).json()) as { runId: string };
		const res = await hono.request(
			new Request(`http://local/runs/${runId}/cancel`, {
				method: "POST",
				headers: { "x-internal-token": TOKEN },
			}),
		);
		expect(res.status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(store.findByRunId(runId)?.status).toBe("aborted");
		expect(stub.aborted).toBe(true);
	});

	it("returns 409 for an already-terminal run", async () => {
		const { hono } = app();
		const { runId } = (await (await hono.request(post(submitBody({ waitMs: 5000 })))).json()) as { runId: string };
		const res = await hono.request(
			new Request(`http://local/runs/${runId}/cancel`, {
				method: "POST",
				headers: { "x-internal-token": TOKEN },
			}),
		);
		expect(res.status).toBe(409);
	});

	it("returns 404 for an unknown runId", async () => {
		const { hono } = app();
		const res = await hono.request(
			new Request("http://local/runs/nope/cancel", {
				method: "POST",
				headers: { "x-internal-token": TOKEN },
			}),
		);
		expect(res.status).toBe(404);
	});
});

describe("assembly failure", () => {
	it("surfaces as a terminal error result, not a fake 202 running", async () => {
		// 新设计里装配失败从 completion 冒出并已落库为 error —— race 把 rejection 吞成
		// timeout 信号后,必须以 store 当前状态为准回 200 error 结果,不许回 202 "running"。
		const manager = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1 }),
			runtimeFactory: async () => {
				throw new Error("mcp server failed to spawn");
			},
		});
		const hono = createApp({ manager, router: new SpecRouter([SPEC]), store, internalToken: TOKEN });
		const res = await hono.request(post(submitBody({ waitMs: 5000 })));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "error", errorMessage: "mcp server failed to spawn" });
		// errorMessage 原样透出是刻意的:单租户内网服务(D6),Java 是受信调用方,需要它排障。
	});
});

describe("error normalization", () => {
	it("returns a generic 500 envelope without stacks or internal paths on unhandled errors", async () => {
		const { hono } = app();
		// 造一个真正的未捕获异常:包一层会抛的 store 交给 createApp,GET 命中它 → onError。
		const throwingStore = {
			...store,
			findByRunId: () => {
				throw new Error("boom at /Users/secret/db.ts");
			},
		} as typeof store;
		void hono;
		const manager = new RunManager({ store, gate: new Gate({}), runtimeFactory: async () => createStubRuntime() });
		const broken = createApp({ manager, router: new SpecRouter([SPEC]), store: throwingStore, internalToken: TOKEN });
		const res = await broken.request(
			new Request("http://local/runs/whatever", { headers: { "x-internal-token": TOKEN } }),
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain("/Users/secret");
		expect(text).not.toContain("boom");
		expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
	});
});

describe("queued runs over HTTP", () => {
	it("reports 202 with status queued while waiting for a global slot", async () => {
		// 每次装配造新 stub(同一实例不支持并发 run());第一个 hang 占住唯一名额。
		const stubs: StubRuntime[] = [];
		const manager = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 2 }),
			runtimeFactory: async () => {
				const stub = createStubRuntime(stubs.length === 0 ? { hang: true } : {});
				stubs.push(stub);
				return stub;
			},
		});
		const hono = createApp({ manager, router: new SpecRouter([SPEC]), store, internalToken: TOKEN });

		const first = await hono.request(post(submitBody({ sessionId: "s1", waitMs: 0 })));
		expect(first.status).toBe(202);

		const second = await hono.request(post(submitBody({ sessionId: "s2", waitMs: 0 })));
		expect(second.status).toBe(202);
		// 排队中的 run 如实报 queued,不谎称 running
		expect(await second.json()).toMatchObject({ status: "queued" });

		stubs[0].resolveNow();
		// 放行后 B 装配、跑完;等两条链落库
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
});

// 规格 §2.7 测试表点名要求的用例(finding #6):"全局队满 → 503 + Retry-After 头"此前在
// HTTP 层零覆盖。同时钉一遍 finding #1:拒绝之后用同一个 clientRequestId 重试必须真的
// 跑起来,不是拿到一行被 markError 钉死的终态行。
describe("queue_full over HTTP", () => {
	it("returns 503 with a Retry-After header and code queue_full, and a same-clientRequestId retry actually runs", async () => {
		const stubs: StubRuntime[] = [];
		const manager = new RunManager({
			store,
			// maxQueueDepth: 0 —— 一旦并发名额占满,下一个请求立刻 queue_full,不必先排队。
			gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 0, retryAfterSeconds: 7 }),
			runtimeFactory: async () => {
				const stub = createStubRuntime(stubs.length === 0 ? { hang: true } : {});
				stubs.push(stub);
				return stub;
			},
		});
		const hono = createApp({ manager, router: new SpecRouter([SPEC]), store, internalToken: TOKEN });

		const first = await hono.request(post(submitBody({ sessionId: "s1", waitMs: 0 })));
		expect(first.status).toBe(202);

		const rejectedBody = submitBody({ clientRequestId: "cli-queue-full", sessionId: "s2", waitMs: 0 });
		const rejected = await hono.request(post(rejectedBody));
		expect(rejected.status).toBe(503);
		expect(rejected.headers.get("Retry-After")).toBe("7");
		expect(await rejected.json()).toMatchObject({ error: { code: "queue_full" } });

		// 放行 A,释放并发名额。
		stubs[0].resolveNow();
		await new Promise((resolve) => setTimeout(resolve, 20));

		// 同一个 clientRequestId 重试:这次必须真的准入、真的装配、真的跑完,而不是命中
		// 拒绝分支之前被 markError 钉死的那一行。
		const retried = await hono.request(post({ ...rejectedBody, waitMs: 5000 }));
		expect(retried.status).toBe(200);
		expect(await retried.json()).toMatchObject({ status: "completed" });
		expect(stubs).toHaveLength(2);
	});
});
