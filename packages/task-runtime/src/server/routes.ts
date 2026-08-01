import type { RunResult } from "../runtime/contract.ts";
import { extractJsonBlock } from "../runtime/output-contract.ts";
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

/**
 * 终态 RunResult → 上线形状。当前只做一件事:把 output 里的 JSON 块解析进 answer。
 *
 * ⚠ **终态结果有四个出口,必须全部经这里**(app.ts 的幂等分支 / 等待窗口超时但行已终态 /
 * 同步完成 / GET /runs/:runId)。其中「同步完成」那条**不经 recordToRunResult** ——
 * 正是这个不对称让 judgeAttempts 在三条路径上恒空、第四条却有真值。把适配放在这个单点上,
 * 而不是塞进 recordToRunResult,就是为了不再重演。
 *
 * 202 分支不经这里:它回的是 {runId, status},非终态、output 还不存在。
 */
export function toWireResult(result: RunResult): RunResult {
	if (result.output === undefined) return result;
	const extracted = extractJsonBlock(result.output);
	// 提取不到就原样返回 —— run 已经完成,拿不到 answer 是降级不是失败。
	if (extracted.kind !== "ok") return result;
	return { ...result, answer: extracted.value };
}
