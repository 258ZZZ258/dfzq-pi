import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../src/runtime/contract.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager, type SubmitRequest } from "../src/server/run-manager.ts";
import type { RunStore } from "../src/store/contract.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime, type StubRuntime } from "./helpers/stub-runtime.ts";

let root: string;
let store: RunStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-rm-"));
	store = createSqliteRunStore(join(root, "runs.db"));
});

afterEach(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

function request(overrides: Partial<SubmitRequest> = {}): SubmitRequest {
	return {
		taskKind: "demo",
		specId: "demo",
		input: "hello",
		clientRequestId: "cli-1",
		sessionId: "sess-1",
		filtersJson: '{"corpusTypes":["internal"]}',
		...overrides,
	};
}

function manager(runtime: Runtime, ids: string[] = ["run-1", "run-2", "run-3"]) {
	let i = 0;
	return new RunManager({
		store,
		gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
		runtimeFactory: async () => runtime,
		now: () => 1000,
		newRunId: () => ids[i++] ?? `run-${i}`,
	});
}

describe("run manager", () => {
	it("accepts a run and persists the terminal result", async () => {
		const rm = manager(createStubRuntime());
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
		const result = await outcome.completion;

		expect(result.status).toBe("completed");
		expect(store.findByRunId(outcome.runId)).toMatchObject({
			status: "completed",
			output: "stub output",
			startedAt: 1000,
			finishedAt: 1000,
		});
	});

	it("returns the existing run for a repeated clientRequestId without starting a second run", async () => {
		const stub = createStubRuntime();
		const rm = manager(stub);
		const first = await rm.submit(request());
		if (first.kind !== "accepted") throw new Error("expected accepted");
		await first.completion;

		const second = await rm.submit(request());
		expect(second.kind).toBe("idempotent");
		if (second.kind !== "idempotent") throw new Error("unreachable");
		expect(second.runId).toBe(first.runId);
		expect(stub.runCalls).toBe(1);
	});

	it("starts only one run when the same clientRequestId arrives concurrently", async () => {
		const stub = createStubRuntime({ delayMs: 5 });
		const rm = manager(stub);
		const [a, b] = await Promise.all([rm.submit(request()), rm.submit(request())]);

		// 新 submit() 在 tryAcquire 前没有 await,首个 submit 同步跑完并写入 live 注册表;
		// 同键的第二个 submit 命中 live,拿到**同一个 completion**(kind 也是 accepted)。
		// 语义要点是「只起一个任务、两个调用方拿到同一个 run 的句柄」,不是 kind 的分布。
		if (a.kind === "rejected" || b.kind === "rejected") throw new Error("unexpected rejection");
		expect(a.runId).toBe(b.runId);
		if (a.kind === "accepted") await a.completion;
		expect(stub.runCalls).toBe(1);
		expect(store.findByRunId(a.runId)?.status).toBe("completed");
	});

	it("rejects a concurrent run on the same session", async () => {
		const stub = createStubRuntime({ hang: true });
		const rm = manager(stub);
		const first = await rm.submit(request());
		if (first.kind !== "accepted") throw new Error("expected accepted");

		const second = await rm.submit(request({ clientRequestId: "cli-2" }));
		expect(second).toEqual({ kind: "rejected", rejection: { kind: "session_busy" } });

		stub.resolveNow();
		await first.completion;
	});

	it("records limit_exceeded with its limit kind", async () => {
		const rm = manager(createStubRuntime({ result: { status: "limit_exceeded", limit: "maxTotalTokens" } }));
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error("expected accepted");
		await outcome.completion;

		expect(store.findByRunId(outcome.runId)).toMatchObject({
			status: "limit_exceeded",
			limitHit: "maxTotalTokens",
		});
	});

	it("records an error terminal status returned by the runtime itself", async () => {
		const rm = manager(createStubRuntime({ result: { status: "error", errorMessage: "provider refused" } }));
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error("expected accepted");
		await outcome.completion;

		expect(store.findByRunId(outcome.runId)).toMatchObject({
			status: "error",
			errorMessage: "provider refused",
		});
	});

	it("marks the run as error when assembly throws, and frees the gate", async () => {
		const gate = new Gate({ maxConcurrent: 1 });
		let n = 0;
		const rm = new RunManager({
			store,
			gate,
			runtimeFactory: async () => {
				throw new Error("mcp server failed to start");
			},
			now: () => 1000,
			// 必须逐次不同:run_id 是主键,ON CONFLICT 只覆盖 client_request_id;
			// 固定返回 "run-1" 会让 retry 的 INSERT 撞主键直接抛。
			newRunId: () => `run-${++n}`,
		});
		// 新设计里装配在 admitAndDrive 内(completion 覆盖「等位→装配→推进」整条链),
		// submit() 本身不再抛 —— 错误从 completion 冒出。
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error("expected accepted");
		await expect(outcome.completion).rejects.toThrow("mcp server failed to start");

		expect(store.findByRunId("run-1")).toMatchObject({
			status: "error",
			errorMessage: "mcp server failed to start",
		});
		// 闸门必须已释放,否则一次装配失败会永久占额
		expect(gate.activeCount).toBe(0);
		const retry = await rm.submit(request({ clientRequestId: "cli-2" }));
		expect(retry.kind).toBe("accepted");
		// retry 的装配同样会抛 —— 必须消费掉这个 rejection,否则挂成 unhandled rejection
		if (retry.kind === "accepted") await retry.completion.catch(() => {});
	});

	it("cancels a running run", async () => {
		const stub = createStubRuntime({ hang: true, result: { status: "aborted" } });
		const rm = manager(stub);
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error("expected accepted");

		expect(await rm.cancel(outcome.runId)).toBe("accepted");
		await outcome.completion;
		expect(store.findByRunId(outcome.runId)?.status).toBe("aborted");
	});

	it("reports already_terminal when cancelling a finished run", async () => {
		const rm = manager(createStubRuntime());
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error("expected accepted");
		await outcome.completion;
		expect(await rm.cancel(outcome.runId)).toBe("already_terminal");
	});

	it("reports not_found for an unknown runId", async () => {
		const rm = manager(createStubRuntime());
		expect(await rm.cancel("nope")).toBe("not_found");
	});

	it("queues past the global limit and completes after the slot frees", async () => {
		// 每次装配都造新 stub:同一 stub 实例不支持并发 run()(Task 3 加的守卫),
		// 且排队路径本来就是「一个 run 一次装配」。
		const stubs: StubRuntime[] = [];
		let n = 0;
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 2 }),
			runtimeFactory: async () => {
				// 第一个 run 挂住占着全局唯一名额;第二个 run 正常完成
				const stub = createStubRuntime(stubs.length === 0 ? { hang: true } : {});
				stubs.push(stub);
				return stub;
			},
			now: () => 1000,
			newRunId: () => `run-${++n}`,
		});

		const a = await rm.submit(request({ sessionId: "s1" }));
		if (a.kind !== "accepted") throw new Error("expected accepted");
		expect(a.queued).toBe(false);

		const b = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		if (b.kind !== "accepted") throw new Error("expected accepted");
		// B 在排全局队:submit 立刻返回(没卡住),行还是 queued —— 尚未装配、尚未 markRunning
		expect(b.queued).toBe(true);
		expect(store.findByRunId(b.runId)?.status).toBe("queued");
		expect(stubs).toHaveLength(1);

		stubs[0].resolveNow();
		await a.completion;
		const resultB = await b.completion;
		expect(resultB.status).toBe("completed");
		expect(store.findByRunId(b.runId)?.status).toBe("completed");
		expect(stubs).toHaveLength(2);
	});

	it("cancels a queued run without ever assembling it", async () => {
		const stubs: StubRuntime[] = [];
		let n = 0;
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 2 }),
			runtimeFactory: async () => {
				const stub = createStubRuntime({ hang: true });
				stubs.push(stub);
				return stub;
			},
			now: () => 1000,
			newRunId: () => `run-${++n}`,
		});

		const a = await rm.submit(request({ sessionId: "s1" }));
		if (a.kind !== "accepted") throw new Error("expected accepted");
		const b = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		if (b.kind !== "accepted") throw new Error("expected accepted");
		expect(b.queued).toBe(true);

		// B 还在排队(没有 runtime 可 abort),cancel 靠 cancelRequested 标志生效
		expect(await rm.cancel(b.runId)).toBe("accepted");

		stubs[0].resolveNow();
		await a.completion;
		const resultB = await b.completion;
		expect(resultB.status).toBe("aborted");
		expect(store.findByRunId(b.runId)?.status).toBe("aborted");
		// ★ 核心断言:B 从未装配 —— 排队中被取消不该起 MCP 子进程白费一次装配
		expect(stubs).toHaveLength(1);
	});
});
