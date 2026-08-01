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
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileRunEvents } from "../src/observability/reconcile.ts";
import { Gate } from "../src/server/gate.ts";
import { RunManager, type SubmitRequest } from "../src/server/run-manager.ts";
import type { RunStore } from "../src/store/contract.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
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

function stubWithToolEvents() {
	return createStubRuntime({
		events: [
			{
				seq: 0,
				type: "tool_execution_start",
				payload: {
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "search_clauses",
					args: { query: SENTINEL_QUERY },
				},
			},
			{
				seq: 1,
				type: "tool_execution_end",
				payload: {
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "search_clauses",
					result: { content: [{ type: "text", text: SENTINEL_CLAUSE_TEXT }] },
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
		expect(rows.some((row) => row.payload.includes("search_clauses"))).toBe(true);

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
	it("run_events read back via store.listEvents() is a usable pi-side source for reconcile()", async () => {
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
		await writeFile(toolLogPath, `${JSON.stringify({ tool: "search_clauses" })}\n`);

		const report = await reconcileRunEvents(events, toolLogPath);
		expect(report.piCalls).toEqual(["search_clauses"]);
		expect(report.schemaMismatch).toBe(false);
		expect(report.vacuous).toBe(false);
		expect(report.ok).toBe(true);
	});
});
