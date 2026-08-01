/**
 * Task 18b:serve 侧事件落库(A6 的 pi 侧凭证)。
 *
 * 缺口:`appendEvents` 声明了、实现了,但在 serve 路径上零调用点 —— RunManager 从未订阅
 * runtime 事件、从未写 run_events。这份测试用既有的 stub runtime 走一次真实 RunManager,
 * 断言三件事(brief Step 1):
 *   1. run 结束后 run_events 有行,且含 tool_execution_start / tool_execution_end 两类;
 *   2. 落库的 payload 里含工具名;
 *   3. 落库的 payload 里不含工具返回体/参数里的正文(脱敏判据,不可省)。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
