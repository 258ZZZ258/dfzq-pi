/**
 * Task 18b:serve 侧事件落库(A6 的 pi 侧凭证)。
 *
 * 缺口:`appendEvents` 声明了、实现了,但在 serve 路径上零调用点 —— RunManager 从未订阅
 * runtime 事件、从未写 run_events。这份测试用既有的 stub runtime 走一次真实 RunManager,
 * 断言三件事(brief Step 1):
 *   1. run 结束后 run_events 有行,且含 tool_execution_start / tool_execution_end 两类;
 *   2. 落库的 payload 里含工具名;
 *   3. 落库的 payload 里不含工具返回体/参数里的正文(脱敏判据,不可省)。
 *
 * 复审 Important-2/Important-3 追加了两块:订阅确实解除(不是只在注释里声称)、
 * run_events 确实能当 reconcile() 的 pi 侧数据源用(不是只写不读)。
 *
 * re-review 追加:`stubWithToolEvents()` 从一次调用改成两次**不同工具名**的调用 ——
 * 一次调用时 piCalls 是单元素数组,`listEvents()` 的 `ORDER BY seq` 无论对错都测不出来
 * (re-review 变异 D:改成 `ORDER BY seq DESC` 全量照样 393 全绿)。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { reconcileRunEvents } from "../src/observability/reconcile.ts";
import type { RuntimeEvent } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager, type SubmitRequest } from "../src/server/run-manager.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import type { RunStore } from "../src/store/contract.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage, fauxToolCall } from "./helpers/faux.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

let root: string;
let dbPath: string;
let store: RunStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-events-"));
	dbPath = join(root, "runs.db");
	store = createSqliteRunStore(dbPath);
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

interface RunEventRow {
	seq: number;
	ts: number;
	type: string;
	payload: string;
}

/** RunStore 的公开契约里没有读 run_events 的方法(只有 appendEvents 这个写方法)——
 *  这条断言链直接开一个只读连接查底层表,而不是给 RunStore 加一个只为测试存在的读接口。 */
function readRunEvents(path: string, runId: string): RunEventRow[] {
	const db = new DatabaseSync(path);
	try {
		const rows = db.prepare("SELECT seq, ts, type, payload FROM run_events WHERE run_id = ? ORDER BY seq").all(runId);
		return rows as unknown as RunEventRow[];
	} finally {
		db.close();
	}
}

// 哨兵串:分别放进 args(检索词)与 result(条款正文)里,断言两者都不出现在任何落库行。
const SENTINEL_QUERY = "SENTINEL_QUERY_条款检索词_7f2c";
const SENTINEL_CLAUSE_TEXT = "SENTINEL_CLAUSE_条款正文原文_9a3e";

/**
 * 两次**不同工具名**的调用(re-review 追加要求):此前只有一次调用,`piCalls` 是单元素
 * 数组,顺序在构造上就不可能被测出来 —— `listEvents()` 的 `ORDER BY seq` 因此零覆盖
 * (re-review 变异 D:改成 `ORDER BY seq DESC` 全量照样 393 全绿)。两次不同工具名的调用
 * 才能让"顺序被保留"这件事有真正可失败的空间。
 */
function stubWithToolEvents() {
	return createStubRuntime({
		events: [
			{
				seq: 0,
				type: "tool_execution_start",
				payload: {
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "search_policy",
					args: { query: SENTINEL_QUERY },
				},
			},
			{
				seq: 1,
				type: "tool_execution_end",
				payload: {
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "search_policy",
					result: { content: [{ type: "text", text: SENTINEL_CLAUSE_TEXT }] },
					isError: false,
				},
			},
			{
				seq: 2,
				type: "tool_execution_start",
				payload: {
					type: "tool_execution_start",
					toolCallId: "call-2",
					toolName: "get_clause_detail",
					args: { clauseId: "c-1" },
				},
			},
			{
				seq: 3,
				type: "tool_execution_end",
				payload: {
					type: "tool_execution_end",
					toolCallId: "call-2",
					toolName: "get_clause_detail",
					result: { content: [{ type: "text", text: "second call, non-sentinel body" }] },
					isError: false,
				},
			},
		],
	});
}

describe("serve 侧事件落库(A6 pi 侧凭证)", () => {
	it("persists a sanitized projection of the whitelisted events once the run finishes", async () => {
		const stub = stubWithToolEvents();
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
			runtimeFactory: async () => stub,
			now: () => 1000,
			newRunId: () => "run-1",
		});

		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
		await outcome.completion;

		const rows = readRunEvents(dbPath, outcome.runId);

		// 判据 1:run_events 有行,且含 tool_execution_start / tool_execution_end 两类。
		const types = rows.map((row) => row.type);
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");

		// 判据 2:落库的 payload 里含工具名。
		expect(rows.some((row) => row.payload.includes("search_policy"))).toBe(true);

		// 判据 3(脱敏,不可省):落库的 payload 里不含工具返回体/参数里的正文。
		const blob = rows.map((row) => row.payload).join("\n");
		expect(blob).not.toContain(SENTINEL_CLAUSE_TEXT);
		expect(blob).not.toContain(SENTINEL_QUERY);
	});

	// 复审 Important-2:此前「三处退出路径都解得掉」只在注释里声称,没有测试保护 ——
	// 审查的变异(摘掉 drive() finally 里那行解订阅)全量 391 全绿。这条用例把它钉住:
	// run 已经落定之后,stub 手动 emit 一条事件,断言它进不了 run_events。
	it("unsubscribes once the run finishes — an event emitted after completion is not persisted", async () => {
		const stub = stubWithToolEvents();
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
			runtimeFactory: async () => stub,
			now: () => 1000,
			newRunId: () => "run-1",
		});

		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
		await outcome.completion;

		const rowsBefore = readRunEvents(dbPath, outcome.runId);
		expect(rowsBefore.length).toBeGreaterThan(0);

		// completion 已经落定 —— RunManager 理应已经解除订阅,这条事件不该有任何监听者接住。
		stub.emit({
			runId: outcome.runId,
			seq: 999,
			type: "tool_execution_end",
			payload: {
				type: "tool_execution_end",
				toolCallId: "ghost",
				toolName: "post_completion_ghost",
				isError: false,
			},
		});

		const rowsAfter = readRunEvents(dbPath, outcome.runId);
		expect(rowsAfter.length).toBe(rowsBefore.length);
		expect(rowsAfter.some((row) => row.payload.includes("post_completion_ghost"))).toBe(false);
	});

	// 复审 Important-3:appendEvents 现在真的写了,但 reconcile() 的 pi 侧数据源
	// (observability/reconcile.ts:47)读的是 trajectory JSONL 文件,不是 run_events ——
	// serve 路径「写了但没人读」是同一个病换了个位置。这条用例证明 store.listEvents() 读回来
	// 的行经 reconcileRunEvents() 能跑出一份非空、非 schemaMismatch 的报告。
	//
	// re-review 追加:fixture 换成两次**不同工具名**的调用,断言 piCalls 精确等于一个
	// **有序**两元素数组 —— 只有这样,listEvents() 的 `ORDER BY seq` 才有真正的失败空间;
	// 单元素数组时"顺序正确"是构造上的巧合,测不出 ORDER BY 被改坏。
	it("run_events read back via store.listEvents() is a usable pi-side source for reconcile(), and preserves call order", async () => {
		const stub = stubWithToolEvents();
		const rm = new RunManager({
			store,
			gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
			runtimeFactory: async () => stub,
			now: () => 1000,
			newRunId: () => "run-1",
		});

		const outcome = await rm.submit(request());
		if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
		await outcome.completion;

		const events = store.listEvents(outcome.runId);
		expect(events.length).toBeGreaterThan(0);

		const toolLogPath = join(root, "tool_calls.jsonl");
		await writeFile(
			toolLogPath,
			[{ tool: "search_policy" }, { tool: "get_clause_detail" }].map((entry) => JSON.stringify(entry)).join("\n"),
		);

		const report = await reconcileRunEvents(events, toolLogPath);
		// 核心判据:两元素有序数组,不是靠单元素巧合"顺序正确"。
		expect(report.piCalls).toEqual(["search_policy", "get_clause_detail"]);
		expect(report.schemaMismatch).toBe(false);
		expect(report.vacuous).toBe(false);
		expect(report.orderMismatch).toBe(false);
		expect(report.ok).toBe(true);
	});
});

/**
 * Task 18c:插件驱动的工具调用进事件流。
 *
 * 缺口(task-18c-brief.md):C3 `sufficiency-gate` 判官经 `PluginContext.callTool` 发起的探针
 * 调用直接打 `tool.execute(...)`(assembler.ts:163-180),绕过 pi 的 agent loop —— 因此不产生
 * `tool_execution_*` 事件,`run_events` 里看不到,A6 对账因此漏记(Task 19 真 run 差 3 条
 * `assess_sufficiency`)。
 *
 * 与 18b 的用例不同:18b 用的是完全假的 `createStubRuntime()`(不经过 assembler.ts /
 * session-runtime.ts,只是照着 `Runtime` 接口手搓的假实现),测不出这个缺口 —— 缺口就在真实
 * assembler 的 `callTool` 里。这组用例改用真实 `createSessionRuntime()`(faux 模型 + 真实
 * 装配管线)配一个真的登记了 `FinalJudge` 的插件,插件在判定时机经 `ctx.callTool()` 调一次
 * 工具,和 faux 模型驱动的两次真实工具调用交错在一次 run 里,包进真实 `RunManager`,断言
 * `run_events`(A6 的 pi 侧凭证)里能看到这次插件驱动的调用。
 *
 * 复审追加(Important-1/Important-2,详见 task-18c-report.md 对应小节):
 *   - 失败路径此前零覆盖:`callTool` 的 catch 分支(`isError:true` 的合成事件 + 异常继续
 *     向上传播)实现从一开始就是对的,但摘掉那一行发射调用点,全量照样绿。新增一条用例
 *     专打这条路径。
 *   - "哨兵不进 clauseIds" 那条用例此前的名字/注释声称自己在验"接线隔离",但两版变异
 *     (含把 `session.subscribe()` 的真实回调原样搬进 `emitPluginToolEvent` 这种最字面的
 *     接错线读法)都翻不了它 —— 根因是 `PluginToolCallEvent` 的 payload 压根不带
 *     `result`,没有内容可漏,发给哪条通路结果都一样。这份区分力其实来自"payload 最小
 *     化",不是"接线正确";名字与注释已改成如实描述,并新增一条真正验证 payload 最小化的
 *     用例(必须读 `runtime.subscribe()` 的原始事件,不能读 `run_events` —— 后者会被落库
 *     前的脱敏投影收窄成固定形状)。
 */
describe("Task 18c: 插件驱动的工具调用进事件流(A6 此前漏记判官探针)", () => {
	const profile: ProviderProfile = {
		id: "test",
		baseUrl: "http://localhost/v1",
		apiKeyEnv: "TEST_KEY",
		api: "openai-completions",
		roles: {
			main: {
				provider: "faux",
				modelId: "faux",
				contextWindow: 8192,
				maxTokens: 1024,
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
	};

	// 插件探针取回的哨兵 clause_id —— 只应该出现在 run_events 里,绝不能出现在 C6 的
	// clauseIds 里(硬性设计约束的可执行凭证,brief Step 1 第 3 条)。
	const PLUGIN_SENTINEL_CLAUSE_ID = "PLUGIN-SENTINEL-CLAUSE-9f3d";

	/**
	 * stopPolicy 可覆盖:成功场景用默认的 `probe-calltool-judge`,Important-1 的失败场景
	 * 传 `probe-calltool-judge-failure` —— 两个判官除此之外共用同一个 spec 骨架。
	 */
	function probeSpec(stopPolicy = "probe-calltool-judge"): RuntimeSpec {
		return {
			id: "demo",
			model: { role: "main" },
			toolset: "probe-toolset",
			// assess_sufficiency* 刻意不在白名单里:只应该被插件经 ctx.callTool() 调用,
			// 模型够不着它们 —— 这样断言里出现的调用一定是插件驱动的,不可能是模型自己选中
			// (faux 模型的应答序列也是手写脚本,和这条约束互相佐证)。
			tools: ["search_policy"],
			limits: { maxTurns: 10 },
			systemPrompt: "You are a test agent.",
			stopPolicy,
		};
	}

	function probeToolset(): ToolsetRegistry {
		const registry = new ToolsetRegistry();
		registry.register("probe-toolset", async () => [
			{
				name: "search_policy",
				label: "Search policy",
				description: "模型驱动的检索工具。",
				parameters: Type.Object({ q: Type.String() }),
				execute: async (_id: string, params: { q: string }) => {
					const payload = JSON.stringify({ hits: [{ clause_id: params.q, text: "……" }] });
					return { output: payload, content: [{ type: "text", text: payload }], details: {} };
				},
			} as never,
			{
				name: "assess_sufficiency",
				label: "Assess sufficiency",
				description: "C3 判官的探针工具,只由插件经 PluginContext.callTool 调用。",
				parameters: Type.Object({ hint: Type.String() }),
				execute: async () => {
					const payload = JSON.stringify({ clause_id: PLUGIN_SENTINEL_CLAUSE_ID });
					return { output: payload, content: [{ type: "text", text: payload }], details: {} };
				},
			} as never,
			{
				// 复审 Important-1:失败路径此前零覆盖。这个工具恒抛,专打 assembler.ts
				// callTool 的 catch 分支(isError:true 的合成事件 + 异常继续向上传播)。
				name: "assess_sufficiency_flaky",
				label: "Assess sufficiency (always fails)",
				description: "C3 判官探针工具的失败版本,只用来测 isError:true 合成事件与异常传播。",
				parameters: Type.Object({ hint: Type.String() }),
				execute: async () => {
					throw new Error("assess_sufficiency_flaky: upstream_failure");
				},
			} as never,
		]);
		return registry;
	}

	/**
	 * 登记一个能拿到 `ctx.callTool` 的判官:第一次判定时经插件通路调一次
	 * `assess_sufficiency`(此时同步记录当前 `clauseIds` 快照),然后要求重判 ——
	 * 逼出第二次模型驱动的工具调用,制造"模型调用 → 插件调用 → 模型调用"的真实交错。
	 * 第二次判定直接通过,run 收尾。
	 */
	function probeCallToolRegistry(seenClauseIds: string[][]) {
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "probe-calltool-judge",
			hooks: [],
			factory: (ctx) => {
				let call = 0;
				ctx.registerFinalJudge({
					name: "probe-calltool-judge",
					maxAttempts: 3,
					onExhausted: "pass",
					judge: async (context) => {
						seenClauseIds.push([...context.clauseIds]);
						call += 1;
						if (call === 1) {
							await ctx.callTool("assess_sufficiency", { hint: "probe" });
							return { ok: false, followUp: "补充证据" };
						}
						return { ok: true };
					},
				});
				return { name: "probe-calltool-judge", factory: () => {} };
			},
		});
		return registry;
	}

	/**
	 * 复审 Important-1:判官经 `ctx.callTool` 调一个恒抛的工具,**不 catch** 这次调用的
	 * rejection —— 让它原样穿透 `judge()`。`runFinalJudges` 在 `judge()` 抛出时会把它转成
	 * `errorMessage`(`final-judge.ts:68-77`),不会静默吞掉、也不会当成 `{ok:true}` 放过 ——
	 * 这就是"异常仍会向上传播"的可观测形态。
	 */
	function probeCallToolFailureRegistry() {
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "probe-calltool-judge-failure",
			hooks: [],
			factory: (ctx) => {
				ctx.registerFinalJudge({
					name: "probe-calltool-judge-failure",
					maxAttempts: 3,
					onExhausted: "pass",
					judge: async () => {
						await ctx.callTool("assess_sufficiency_flaky", { hint: "probe" });
						return { ok: true };
					},
				});
				return { name: "probe-calltool-judge-failure", factory: () => {} };
			},
		});
		return registry;
	}

	interface ProbeScenario {
		rows: RunEventRow[];
		seenClauseIds: string[][];
		/**
		 * `runtime.subscribe()` 抓到的原始事件 —— **不经过** 18b 落库前的脱敏投影
		 * (`server/run-manager.ts` 的 `toStoredEvent`)。有些断言必须读这份原始数据,
		 * 见下面"合成事件本身是最小字段集合"用例的注释。
		 */
		rawEvents: RuntimeEvent[];
	}

	/**
	 * 走一次完整的 run:真实 `RunManager` + 真实 `createSessionRuntime()`(faux 模型)。
	 * faux 应答脚本编排的真实发生顺序是:
	 *   1. 模型调用 search_policy(q: REAL-1)                      [真实,turn 1]
	 *   2. 模型给出草稿文本,session.prompt() 返回                  [真实,turn 2]
	 *   3. 判官经 ctx.callTool 调 assess_sufficiency(插件驱动)      [合成]
	 *   4. 判官判定不足,派发 reprompt
	 *   5. 模型调用 search_policy(q: REAL-2)                      [真实,turn 3]
	 *   6. 模型给出终稿文本,session.prompt() 返回,判官判定通过     [真实,turn 4]
	 */
	async function runProbeScenario(): Promise<ProbeScenario> {
		const harness = await createFauxHarness();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("search_policy", { q: "REAL-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("draft answer"),
				fauxAssistantMessage([fauxToolCall("search_policy", { q: "REAL-2" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("final answer"),
			]);

			const seenClauseIds: string[][] = [];
			const rawEvents: RuntimeEvent[] = [];
			const rm = new RunManager({
				store,
				gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
				runtimeFactory: async () => {
					const runtime = await createSessionRuntime({
						spec: probeSpec(),
						profile,
						registry: probeCallToolRegistry(seenClauseIds),
						toolsets: probeToolset(),
						cwd: harness.cwd,
						agentDir: harness.agentDir,
						modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
					});
					// 额外挂一路只读订阅,抓 emitPluginToolEvent 发出的**原始** RuntimeEvent ——
					// 与 RunManager 自己那路(落库用,subscribeEvents)相互独立的两个订阅者,
					// 谁先谁后不影响谁看到什么(listeners 是一个 Set,fan-out 时逐个通知)。
					runtime.subscribe((event) => rawEvents.push(event));
					return runtime;
				},
				now: () => 1000,
				newRunId: () => "run-1",
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			const result = await outcome.completion;
			if (result.status !== "completed") {
				throw new Error(`expected run to complete, got status "${result.status}": ${result.errorMessage}`);
			}

			return { rows: readRunEvents(dbPath, outcome.runId), seenClauseIds, rawEvents };
		} finally {
			await harness.cleanup();
		}
	}

	/**
	 * 复审 Important-1 的失败场景:只需一个不带工具调用的模型回合(`session.prompt()` 立刻
	 * 返回,判官紧接着触发),然后判官经 `ctx.callTool` 调 `assess_sufficiency_flaky` ——
	 * 它恒抛。返回 `result` 而不只是 `rows`:要断言异常真的向上传播了,得看最终的 RunResult。
	 */
	async function runProbeFailureScenario() {
		const harness = await createFauxHarness();
		try {
			harness.faux.setResponses([fauxAssistantMessage("draft answer")]);

			const rm = new RunManager({
				store,
				gate: new Gate({ maxConcurrent: 2, maxQueueDepth: 2 }),
				runtimeFactory: async () =>
					createSessionRuntime({
						spec: probeSpec("probe-calltool-judge-failure"),
						profile,
						registry: probeCallToolFailureRegistry(),
						toolsets: probeToolset(),
						cwd: harness.cwd,
						agentDir: harness.agentDir,
						modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
					}),
				now: () => 1000,
				newRunId: () => "run-fail-1",
			});

			const outcome = await rm.submit(request());
			if (outcome.kind !== "accepted") throw new Error(`expected accepted, got ${outcome.kind}`);
			const result = await outcome.completion;

			return { rows: readRunEvents(dbPath, outcome.runId), result };
		} finally {
			await harness.cleanup();
		}
	}

	/** run_events 里的 tool_execution_start/end 行,按 seq 序投影成 "type:toolName"。 */
	function toolEventSequence(rows: RunEventRow[]): string[] {
		return rows
			.filter((row) => row.type === "tool_execution_start" || row.type === "tool_execution_end")
			.map((row) => `${row.type}:${(JSON.parse(row.payload) as { toolName?: string }).toolName}`);
	}

	/**
	 * 从原始 RuntimeEvent 流(`runProbeScenario()` 的 `rawEvents`,未经落库前的脱敏投影)
	 * 里挑出某个工具名的 tool_execution_start / tool_execution_end 各一条。
	 */
	function rawToolEvents(rawEvents: RuntimeEvent[], toolName: string) {
		const matches = rawEvents.filter(
			(event) =>
				(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
				typeof event.payload === "object" &&
				event.payload !== null &&
				(event.payload as { toolName?: unknown }).toolName === toolName,
		);
		return {
			start: matches.find((event) => event.type === "tool_execution_start"),
			end: matches.find((event) => event.type === "tool_execution_end"),
		};
	}

	// brief Step 1 第 1 条的补充:插件驱动的调用产生的合成事件本身
	// (`emitPluginToolEvent` 发出的原始 RuntimeEvent)是最小字段集合 —— 不带 result/args。
	//
	// 复审 Important-2 + Minor-1:
	//   - "run_events 里有 assess_sufficiency、toolName 正确"这件事已经被下面顺序用例的
	//     `toEqual` 严格蕴含(有序数组精确匹配天然要求这两行存在且 toolName 正确)——
	//     这里若再用 `toContain` 重复断言一次,是零独立区分力的重复劳动(Minor-1),已删除。
	//   - 这里改测顺序用例根本碰不到的维度:合成事件的 payload 形状。这条断言**必须**读
	//     `runtime.subscribe()` 抓到的原始事件,不能读 `run_events`:落库前的脱敏投影
	//     (`server/run-manager.ts` 的 `toStoredEvent`)会把 payload 重新收窄成固定的
	//     `{type,seq,ts,toolName?,isError?}`,不管原始 payload 里塞了什么 —— 从 run_events
	//     读回来的行永远是这个形状,哪怕真往 `PluginToolCallEvent` 加了 `result`,这层落库
	//     脱敏也会把它悄悄滤掉,测不出来。
	it("插件经 ctx.callTool 发起的调用,合成事件本身是最小字段集合(不带 result/args)", async () => {
		const { rawEvents } = await runProbeScenario();
		const { start, end } = rawToolEvents(rawEvents, "assess_sufficiency");
		expect(start).toBeDefined();
		expect(end).toBeDefined();
		expect(Object.keys(start?.payload as object).sort()).toEqual(["toolName", "type"]);
		expect(Object.keys(end?.payload as object).sort()).toEqual(["isError", "toolName", "type"]);
		expect((end?.payload as { isError?: boolean }).isError).toBe(false);
	});

	// brief Step 1 第 2 条:插件调用与模型驱动调用交错时,run_events 的 seq 顺序要与真实发生
	// 顺序一致。⚠ 有序比较(toEqual),不用 toContain/arrayContaining —— 本轮已经在别的任务
	// 栽过一次(fixture 只有一次调用,顺序在构造上就测不出来)。这条同时是 brief 第 1 条
	// "存在性 + toolName 正确"的严格超集(有序数组精确匹配天然蕴含成员关系)。
	it("插件调用与模型驱动调用交错时,run_events 的 seq 顺序与真实发生顺序一致", async () => {
		const { rows } = await runProbeScenario();
		const sequence = toolEventSequence(rows);
		expect(sequence).toEqual([
			"tool_execution_start:search_policy",
			"tool_execution_end:search_policy",
			"tool_execution_start:assess_sufficiency",
			"tool_execution_end:assess_sufficiency",
			"tool_execution_start:search_policy",
			"tool_execution_end:search_policy",
		]);
	});

	// brief Step 1 第 3 条 —— 复审 Important-2 改过名字与注释,如实描述这条测的是什么:
	//
	// 这条测的是"payload 最小化",不是"接线隔离"。原先的名字/注释声称它验证"合成事件只发进
	// listeners、不发进 session.subscribe() 那条通路";但复审做了两版变异(含最字面的读法:
	// 把 session.subscribe() 的真实回调原样抽成函数、在 emitPluginToolEvent 里照样调一遍),
	// 哨兵断言两次都没翻红。根因是 `PluginToolCallEvent` 的类型只有 `{type,toolName}` /
	// `{type,toolName,isError}`,压根不带 `result` —— 不管把合成事件发给哪条通路,
	// `collectClauseIds(event.result, …)` 拿到的都是 `undefined`,没有内容可漏。这条用例的
	// 区分力落在"payload 最小化"上,不在"接线正确"上;不去构造一个牵强的接线测试来伪造
	// 区分力。
	//
	// 真正的防线有两层,都不是这条用例自己给的:
	//   1. 类型层:`emitPluginToolEvent?.({...})` 的调用点是对象字面量,TS 的多余属性检查会
	//      在编译期拒绝任何未声明字段。实测验证过(未提交,验证后已还原):往
	//      assembler.ts:208 的调用点加一个 `args` 字段,`npx tsgo --noEmit` 报
	//      `error TS2353: Object literal may only specify known properties, and 'args' does
	//      not exist in type '{ type: "tool_execution_start"; toolName: string; }'.`
	//      —— 而 `tsgo --noEmit` 就在门禁里。
	//   2. 运行时层:上面"合成事件本身是最小字段集合"那条用例直接断言了原始 payload 的精确
	//      字段集合 —— 这才是能在**运行时**捕捉"有人往 PluginToolCallEvent 加了 result"的
	//      那条防线(它读的是 runtime.subscribe() 的原始事件,不是 run_events;后者会被
	//      落库前的脱敏投影收窄成固定形状,测不出这个)。
	//
	// 这条用例继续保留,作为回归锁(哨兵串真的不会出现在 clauseIds 里),但不再声称自己在验
	// "接线隔离"。
	it("插件调用取回的 clause_id 哨兵不会进入 C6 的 clauseIds(回归锁 —— 真正防线见上方注释)", async () => {
		const { seenClauseIds } = await runProbeScenario();
		const allSeen = seenClauseIds.flat();
		expect(allSeen).not.toContain(PLUGIN_SENTINEL_CLAUSE_ID);
		// 模型驱动的检索仍然照常填充 clauseIds —— 证明这不是"clauseIds 整体没工作",
		// 而是精确排除了插件驱动的那一次。
		expect(seenClauseIds[0]).toEqual(["REAL-1"]);
	});

	// 复审 Important-1:失败路径(callTool 的 catch 分支)brief 明写要发
	// tool_execution_end(isError:true)、且异常不能被吞掉 —— 实现从一开始就是对的
	// (assembler.ts 的 catch 分支),但此前没有任何测试覆盖它:复审摘掉这一行发射调用点后
	// 跑全量,398 全绿。这条路径不是假设场景 —— Task 19 的一次配置疏漏就制造过 10 次
	// upstream_failure。
	it("插件调用会抛异常的工具时,run_events 里的 tool_execution_end 带 isError:true,且异常仍会向上传播", async () => {
		const { rows, result } = await runProbeFailureScenario();

		const ends = rows
			.filter((row) => row.type === "tool_execution_end")
			.map((row) => JSON.parse(row.payload) as { toolName?: string; isError?: boolean });
		const flaky = ends.find((event) => event.toolName === "assess_sufficiency_flaky");
		expect(flaky).toBeDefined();
		expect(flaky?.isError).toBe(true);

		// 异常没有被 callTool 吞掉:runFinalJudges 在 judge() 抛出时把它转成 errorMessage
		// (不是静默当成 {ok:true} 放过),最终 run 的状态与错误信息里带着这次失败的痕迹。
		expect(result.status).toBe("error");
		expect(result.errorMessage).toContain("upstream_failure");
	});
});
