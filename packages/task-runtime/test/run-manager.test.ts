import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../src/runtime/contract.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager, type RuntimeFactory, type SubmitRequest } from "../src/server/run-manager.ts";
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
		filters: { permTags: [], corpusTypes: ["internal"] },
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

	// finding #1:闸门拒绝不能烧掉幂等键。以下两个用例是核心的红/绿钉桩 ——
	// B 第一次被拒后,用同一个 clientRequestId 重试必须真的重新走一遍准入,而不是命中一行
	// 已经被 markError 钉死的终态行。
	it("session_busy rejection does not burn the idempotency key — retrying with the same clientRequestId actually runs", async () => {
		const stubs: StubRuntime[] = [];
		let factoryCalls = 0;
		let n = 0;
		const gate = new Gate({ maxConcurrent: 2, maxQueueDepth: 2 });
		const rm = new RunManager({
			store,
			gate,
			runtimeFactory: async () => {
				factoryCalls++;
				const stub = createStubRuntime(stubs.length === 0 ? { hang: true } : {});
				stubs.push(stub);
				return stub;
			},
			now: () => 1000,
			newRunId: () => `run-${++n}`,
		});

		const a = await rm.submit(request({ sessionId: "s1" }));
		if (a.kind !== "accepted") throw new Error("expected accepted");

		const rejected = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s1" }));
		expect(rejected).toEqual({ kind: "rejected", rejection: { kind: "session_busy" } });
		// 拒绝分支必须把 insertQueued 原子占下的行删掉,不是 markError 钉成终态。
		expect(store.findByRunId("run-2")).toBeUndefined();

		// 释放 A,session 位随之解除。
		stubs[0].resolveNow();
		await a.completion;

		// 同一 clientRequestId 重试:这次必须真的准入、真的装配、真的跑完 —— 不是拿到一行
		// 早就 error 掉的死行。
		const retry = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s1" }));
		expect(retry.kind).toBe("accepted");
		if (retry.kind !== "accepted") throw new Error("unreachable");
		const result = await retry.completion;
		expect(result.status).toBe("completed");
		expect(factoryCalls).toBe(2);
		expect(store.findByRunId(retry.runId)?.status).toBe("completed");
	});

	it("queue_full rejection does not burn the idempotency key — retrying with the same clientRequestId actually runs", async () => {
		const stubs: StubRuntime[] = [];
		let factoryCalls = 0;
		let n = 0;
		const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 0 });
		const rm = new RunManager({
			store,
			gate,
			runtimeFactory: async () => {
				factoryCalls++;
				const stub = createStubRuntime(stubs.length === 0 ? { hang: true } : {});
				stubs.push(stub);
				return stub;
			},
			now: () => 1000,
			newRunId: () => `run-${++n}`,
		});

		const a = await rm.submit(request({ sessionId: "s1" }));
		if (a.kind !== "accepted") throw new Error("expected accepted");

		const rejected = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		expect(rejected).toEqual({ kind: "rejected", rejection: { kind: "queue_full", retryAfterSeconds: 5 } });
		expect(store.findByRunId("run-2")).toBeUndefined();

		stubs[0].resolveNow();
		await a.completion;

		const retry = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		expect(retry.kind).toBe("accepted");
		if (retry.kind !== "accepted") throw new Error("unreachable");
		const result = await retry.completion;
		expect(result.status).toBe("completed");
		expect(factoryCalls).toBe(2);
		expect(store.findByRunId(retry.runId)?.status).toBe("completed");
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

	// finding #2:落库失败不该永久泄漏闸门名额、钉死会话,也不该盖过原始错误。
	// 三处「裸」store 写入(assembly 失败的 markError、markRunning、finishAsAborted 的
	// finish)各来一个 brittle store 用例。
	describe("store write failures during admission/drive must not leak the gate or mask the real error", () => {
		it("assembly-failure markError throwing does not mask the original error, and still frees the gate", async () => {
			const gate = new Gate({ maxConcurrent: 1 });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const brittleStore: RunStore = {
				...store,
				markError: () => {
					throw new Error("SQLITE_FULL");
				},
			};
			let n = 0;
			const rm = new RunManager({
				store: brittleStore,
				gate,
				runtimeFactory: async () => {
					throw new Error("mcp spawn failed");
				},
				now: () => 1000,
				// run_id 是主键,两次 submit 必须拿到不同 runId,否则第二次 insertQueued 会撞
				// UNIQUE 约束直接抛(与「marks the run as error when assembly throws」用例同理)。
				newRunId: () => `run-${++n}`,
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error("expected accepted");
			// completion 的 rejection 必须是原始错误("mcp spawn failed"),不是把它盖掉的
			// 次生 markError 失败("SQLITE_FULL")。
			await expect(outcome.completion).rejects.toThrow("mcp spawn failed");

			expect(gate.activeCount).toBe(0);
			expect(
				errorSpy.mock.calls.some(
					([msg]) =>
						typeof msg === "string" && msg.includes("failed to mark run") && msg.includes("assembly failed"),
				),
			).toBe(true);

			// 同 session 能再次准入 —— 证明 live 注册表也被清理了,不是只有 gate 释放了。
			const second = await rm.submit(request({ clientRequestId: "cli-2" }));
			expect(second.kind).toBe("accepted");
			if (second.kind === "accepted") await second.completion.catch(() => {});

			errorSpy.mockRestore();
		});

		it("markRunning throwing releases the gate, disposes the runtime, and surfaces markRunning's own error", async () => {
			const gate = new Gate({ maxConcurrent: 1 });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			let disposeCalls = 0;
			const stub = createStubRuntime();
			const trackedRuntime: Runtime = {
				...stub,
				dispose: async () => {
					disposeCalls++;
				},
			};
			const brittleStore: RunStore = {
				...store,
				markRunning: () => {
					throw new Error("SQLITE_FULL");
				},
			};
			const rm = new RunManager({
				store: brittleStore,
				gate,
				runtimeFactory: async () => trackedRuntime,
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error("expected accepted");
			await expect(outcome.completion).rejects.toThrow("SQLITE_FULL");

			expect(gate.activeCount).toBe(0);
			expect(disposeCalls).toBe(1);
			expect(
				errorSpy.mock.calls.some(
					([msg]) => typeof msg === "string" && msg.includes("mark run") && msg.includes("running"),
				),
			).toBe(true);

			errorSpy.mockRestore();
		});

		it("finish() throwing while finishing a cancelled-while-queued run still releases the gate slot", async () => {
			const gate = new Gate({ maxConcurrent: 1, maxQueueDepth: 1 });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const stubs: StubRuntime[] = [];
			let n = 0;
			// 只让 B(run-2)的 finish 抛:A(run-1)要走正常的 drive() 完成路径把自己的
			// 名额还回去,不然 A 自己的 store.finish 也被写坏,会在 a.completion 上炸出一个
			// 与本用例无关的第二个 unhandled rejection。
			const brittleStore: RunStore = {
				...store,
				finish: (runId, result, finishedAt) => {
					if (runId === "run-2") throw new Error("SQLITE_FULL");
					store.finish(runId, result, finishedAt);
				},
			};
			const rm = new RunManager({
				store: brittleStore,
				gate,
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

			// B 还在排队(从未装配),此刻取消它 —— 之后的收尾会走 finishAsAborted。
			expect(await rm.cancel(b.runId)).toBe("accepted");

			stubs[0].resolveNow();
			await a.completion;
			await expect(b.completion).rejects.toThrow("SQLITE_FULL");

			// A 与 B 的名额都必须已经释放。
			expect(gate.activeCount).toBe(0);
			expect(gate.queueDepth).toBe(0);
			expect(errorSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("aborted result"))).toBe(
				true,
			);

			errorSpy.mockRestore();
		});

		// task-21 复审 必修2:上面那条用例走的是「排队中被取消」(admitAndDrive:268 的早退出
		// 分支,cancelRequested 在装配开始前就已经是 true,那条分支外面根本没有 runtime/订阅
		// 要收尾,自然也没有 try/finally)。这里补的是另一条完全不同的分支——「装配已经成功、
		// runtime 已建好,但 run() 还没起步时才被 cancel」(admitAndDrive:313-326),真实场景
		// 是 cancel() 恰好夹在「装配完成」和「markRunning 前」之间的 race。这条分支才有
		// `try { return await this.finishAsAborted(...) } finally { unsubscribeEvents();
		// await runtime.dispose()… }`,上一条用例的分支覆盖不到它。
		//
		// 终审变异实测:把这段 try/finally 退回修复前的三条顺序语句
		// (`const result = await this.finishAsAborted(...); unsubscribeEvents(); await
		// runtime.dispose()…; return result;`)——finishAsAborted() 一抛,后两条语句被跳过,
		// 401 passed / 0 red,没有任何用例守到 dispose() 与 unsubscribe。dispose() 被跳过是真的
		// 漏:MCP 子进程不会被回收。
		it("finish() throwing while finishing an assembled-then-cancelled-before-run() run still disposes the runtime and unsubscribes events", async () => {
			const gate = new Gate({ maxConcurrent: 1 });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			let disposeCalls = 0;
			const stub = createStubRuntime();
			const trackedRuntime: Runtime = {
				...stub,
				dispose: async () => {
					disposeCalls++;
					await stub.dispose();
				},
			};
			let appendEventsCalls = 0;
			const brittleStore: RunStore = {
				...store,
				appendEvents: (runId, events) => {
					appendEventsCalls++;
					store.appendEvents(runId, events);
				},
				finish: () => {
					throw new Error("SQLITE_FULL");
				},
			};
			// rm 在自己的 runtimeFactory 闭包里被引用 —— 闭包只在 submit() 触发装配时才真正
			// 执行,那时 rm 早已完成初始化(自引用闭包,不是 TDZ 访问)。这是复现"装配完成瞬间
			// 调用 cancel()"这个 race 唯一的办法,cancelRequested 是私有字段,测试到不了。
			const rm: RunManager = new RunManager({
				store: brittleStore,
				gate,
				runtimeFactory: async ({ runId }) => {
					// 模拟 run-manager.ts:307-312 描述的 race:装配已经成功但 run() 还没起步,此刻
					// cancel() 恰好落进来。
					await rm.cancel(runId);
					return trackedRuntime;
				},
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error("expected accepted");
			// 异常仍须向上传播 —— finally 不吞异常。
			await expect(outcome.completion).rejects.toThrow("SQLITE_FULL");

			// runtime.dispose() 必须被调用过,否则 MCP 子进程不会被回收。
			expect(disposeCalls).toBe(1);

			// 事件订阅必须已解除:run 已经以异常终止之后再 emit 一条事件,不该有任何监听者接住。
			stub.emit({
				type: "tool_execution_end",
				payload: {
					type: "tool_execution_end",
					toolCallId: "ghost",
					toolName: "post_completion_ghost",
					isError: false,
				},
			});
			expect(appendEventsCalls).toBe(0);

			errorSpy.mockRestore();
		});
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

	it("cancel() catches a throwing abort() and still reports accepted", async () => {
		// stub 本身的 abort() 不抛;真实 SessionRuntime.abort() 可能抛(session.abort() 会
		// 传播失败,见 session-runtime.ts 里的注释)。这里手搓一个会抛的 abort() 来复现那条路径。
		const stub = createStubRuntime({ hang: true });
		const throwingRuntime: Runtime = {
			...stub,
			abort: async () => {
				throw new Error("session abort failed");
			},
		};
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1 }),
			runtimeFactory: async () => throwingRuntime,
			now: () => 1000,
			newRunId: () => "run-1",
		});
		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error("expected accepted");

		// abort() 会抛,但 cancel() 必须吞掉它、仍然报 "accepted"(不能变成 reject 的
		// Promise —— HTTP 层的契约是 202/404/409 三态之一,不是 500)。
		await expect(rm.cancel(outcome.runId)).resolves.toBe("accepted");

		// throwingRuntime.abort() 被替换掉了,不会触发 stub 内部的 settle();手动放行
		// 让 run() 落定,避免测试挂死,并确认不会产生 unhandled rejection。
		stub.resolveNow();
		await outcome.completion;
	});

	it("dedupe branch reports the current queued state, not a stale creation-time snapshot", async () => {
		const stubs: StubRuntime[] = [];
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 1, maxQueueDepth: 2 }),
			runtimeFactory: async (input) => {
				// A 占住全局唯一名额并挂住;B 装配后用 delayMs 给 "running" 状态留一个可观察的窗口
				// (而不是靠 resolveNow() 手动落定,这样才能在 B 转入 running 之后、完成之前插入
				// 一次同键重试去观察 queued:false)。
				const stub =
					input.sessionId === "s1" ? createStubRuntime({ hang: true }) : createStubRuntime({ delayMs: 5 });
				stubs.push(stub);
				return stub;
			},
			now: () => 1000,
			newRunId: (() => {
				let n = 0;
				return () => `run-${++n}`;
			})(),
		});

		const a = await rm.submit(request({ sessionId: "s1" }));
		if (a.kind !== "accepted") throw new Error("expected accepted");

		const b = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		if (b.kind !== "accepted") throw new Error("expected accepted");
		expect(b.queued).toBe(true);

		// B 还在排全局队(A 没让出名额,B 还没装配):同键重试应报 queued:true —— 此刻确实
		// 还没开始跑。
		const retryWhileQueued = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		if (retryWhileQueued.kind !== "accepted") throw new Error("expected accepted");
		expect(retryWhileQueued.runId).toBe(b.runId);
		expect(retryWhileQueued.queued).toBe(true);

		// 放行 A,B 拿到全局名额、装配、markRunning —— 转入 running。
		stubs[0].resolveNow();
		await a.completion;

		// A 的释放到 B 的 markRunning 之间全是微任务(装配 runtimeFactory、赋值 entry.runtime、
		// 写 store),没有真实定时器;一个 0ms 的宏任务 tick 足够把它们全部冲刷掉,同时 B 自己
		// 那个 5ms 的 delayMs 定时器此刻还没到期 —— 这就是能观察到 "running" 的窗口。
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(store.findByRunId(b.runId)?.status).toBe("running");

		// 现在同键重试应报 queued:false —— 已经在跑,不是"还在排队"。
		const retryWhileRunning = await rm.submit(request({ clientRequestId: "cli-2", sessionId: "s2" }));
		if (retryWhileRunning.kind !== "accepted") throw new Error("expected accepted");
		expect(retryWhileRunning.runId).toBe(b.runId);
		expect(retryWhileRunning.queued).toBe(false);

		const resultB = await b.completion;
		expect(resultB.status).toBe("completed");
		expect(store.findByRunId(b.runId)?.status).toBe("completed");
	});

	describe("授权位透传(C10 上半段)", () => {
		it("hands runId and structured filters/options to the runtime factory", async () => {
			const seen: Array<Parameters<RuntimeFactory>[0]> = [];
			const runtime = createStubRuntime();
			const rm = new RunManager({
				store,
				gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
				runtimeFactory: async (input) => {
					seen.push(input);
					return runtime;
				},
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const outcome = await rm.submit(
				request({
					filters: { permTags: ["p1"], corpusTypes: ["internal"] },
					options: { topK: 8, includeSuperseded: false },
				}),
			);
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			expect(seen).toHaveLength(1);
			// runId 必须与 submit 返回的一致 —— C1 的 per-run 白名单拿它当隔离键(规格 §3.3)。
			// S3 池化后 MCP server 跨 run 复用,靠进程隔离的白名单会串 run。
			expect(seen[0].runId).toBe(outcome.runId);
			expect(seen[0].filters).toEqual({ permTags: ["p1"], corpusTypes: ["internal"] });
			expect(seen[0].options).toEqual({ topK: 8, includeSuperseded: false });
		});

		it("defaults options to an empty object rather than undefined", async () => {
			const seen: Array<Parameters<RuntimeFactory>[0]> = [];
			const runtime = createStubRuntime();
			const rm = new RunManager({
				store,
				gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
				runtimeFactory: async (input) => {
					seen.push(input);
					return runtime;
				},
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			// 下游解构 options.topK 时不该先判 undefined —— 空对象让消费方少一条分支。
			expect(seen[0].options).toEqual({});
		});

		it("archives filters as JSON without asking the caller to stringify", async () => {
			const rm = manager(createStubRuntime());
			const outcome = await rm.submit(request({ filters: { permTags: [], corpusTypes: ["internal", "external"] } }));
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			const row = store.findByRunId(outcome.runId);
			expect(JSON.parse(row?.filtersJson ?? "null")).toEqual({
				permTags: [],
				corpusTypes: ["internal", "external"],
			});
		});
	});

	describe("payload 透传(规格 §7.1)", () => {
		it("hands payload to the runtime factory", async () => {
			const seen: Array<Parameters<RuntimeFactory>[0]> = [];
			const runtime = createStubRuntime();
			const rm = new RunManager({
				store,
				gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
				runtimeFactory: async (input) => {
					seen.push(input);
					return runtime;
				},
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const payload = { external: { objectKey: "k", uploadId: "U1", filename: "f" } };
			const outcome = await rm.submit(request({ payload }));
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			expect(seen).toHaveLength(1);
			expect(seen[0].payload).toEqual(payload);
		});

		it("does not default payload to an empty object when the caller omits it", async () => {
			const seen: Array<Parameters<RuntimeFactory>[0]> = [];
			const runtime = createStubRuntime();
			const rm = new RunManager({
				store,
				gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
				runtimeFactory: async (input) => {
					seen.push(input);
					return runtime;
				},
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			// 与 options 不同:payload 不该被补成 {} —— 装配期的 parseCoveragePayload 等校验
			// 要能分清「没传 payload」与「传了空对象」,不套用 options「缺省即空对象」那条纪律。
			expect(seen[0].payload).toBeUndefined();
		});

		it("archives payload as JSON verbatim without asking the caller to stringify", async () => {
			const rm = manager(createStubRuntime());
			const payload = { external: { objectKey: "k", uploadId: "U1", filename: "f", meta: { ocr: null } } };
			const outcome = await rm.submit(request({ payload }));
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			const row = store.findByRunId(outcome.runId);
			expect(JSON.parse(row?.payloadJson ?? "null")).toEqual(payload);
		});

		it("leaves payloadJson undefined when the caller omits payload", async () => {
			const rm = manager(createStubRuntime());
			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			await outcome.completion;

			const row = store.findByRunId(outcome.runId);
			expect(row?.payloadJson).toBeUndefined();
		});
	});
});
