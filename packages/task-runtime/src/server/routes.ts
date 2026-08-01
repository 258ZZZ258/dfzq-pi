import type { RunResult } from "../runtime/contract.ts";
import type { RunRecord } from "../store/contract.ts";

/** 终态行 → RunResult 形状,给 GET /runs/{runId} 用。 */
export function recordToRunResult(row: RunRecord): RunResult {
	const usage = row.usageJson
		? (JSON.parse(row.usageJson) as RunResult["usage"])
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	return {
		// judgeAttempts 只服务**进程内验收**,不落库(已决,规格-制度查询验收 §4.3)。
		// 三件事连起来看才成立:
		//   1. 持久化层不存这个字段,所以从 SQLite 读回时只能是 {};
		//   2. 长 run 都走 202 + 轮询,**通过 HTTP 拿到的这个字段恒为空**,
		//      只有 waitMs 内同步完成的响应才有真值(POST /runs 直接回 completion 的
		//      RunResult,不经过这个函数 —— 见 server/app.ts 里 `c.json(raced as RunResult, 200)`
		//      与本函数被调用的另外几处 GET/POST 分支的对照);
		//   3. ⇒ A6 的工具调用对账**以 MCP 侧审计日志为准**,不用这个字段。
		// 要改成可用得先在持久化层加列 —— 那是 S2 的事,不在本轮范围。
		judgeAttempts: {},
		runId: row.runId,
		specId: row.specId,
		status: row.status as RunResult["status"],
		output: row.output,
		errorMessage: row.errorMessage,
		stopReason: row.stopReason,
		limit: row.limitHit,
		usage,
		turns: row.turns ?? 0,
		durationMs: row.finishedAt && row.startedAt ? row.finishedAt - row.startedAt : 0,
	};
}

export function isTerminal(status: RunRecord["status"]): boolean {
	return status !== "queued" && status !== "running";
}
