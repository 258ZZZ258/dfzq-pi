import { readFile } from "node:fs/promises";
import { readTrajectory } from "./trajectory.ts";

export interface ReconcileReport {
	ok: boolean;
	piCalls: string[];
	mcpCalls: string[];
	/** pi 记了但 MCP 侧没有 */
	missingInMcp: string[];
	/** MCP 侧有但 pi 没记 */
	missingInPi: string[];
	orderMismatch: boolean;
	/**
	 * trajectory 里有 `tool_execution_end` 事件,却提不出工具名 —— 说明 pi 的事件 schema
	 * 变了(字段改名/嵌套层级变动)。这不是「两侧不一致」,是**尺子坏了**,必须区别对待:
	 * 否则报告会指向 MCP 侧,而根因在 pi 的上游改动。
	 */
	schemaMismatch: boolean;
	/**
	 * 两侧都没有任何工具调用。可能是任务本就没用工具(合法),也可能是事件类型改名
	 * 加 EVAL_TASK_LOG 没接通(两边同时坏)。**这种情况不能声称「一致」** ——
	 * 对账没有比较任何东西,`ok` 为真会变成一份假的通过凭证。
	 */
	vacuous: boolean;
}

/**
 * 多 server 同名时 adapter 会加 "<serverId>__" 前缀。
 * 只在前缀真正匹配某个已知 server id 时才剥离,防止误剔真实工具名里的 "__"。
 * 不传 knownServerIds 时不做任何剥离。
 */
function stripServerPrefix(name: string, knownServerIds?: string[]): string {
	if (!knownServerIds || knownServerIds.length === 0) {
		return name;
	}
	const index = name.indexOf("__");
	if (index < 0) return name;
	const prefix = name.slice(0, index);
	return knownServerIds.includes(prefix) ? name.slice(index + 2) : name;
}

export async function reconcile(
	trajectoryPath: string,
	toolLogPath: string,
	knownServerIds?: string[],
): Promise<ReconcileReport> {
	const events = await readTrajectory(trajectoryPath);
	const piCalls = events
		.filter((event) => event.type === "tool_execution_end")
		.map((event) => {
			const payload = event.payload;
			if (typeof payload !== "object" || payload === null) return "";
			const toolName = String((payload as { toolName?: string }).toolName ?? "");
			return stripServerPrefix(toolName, knownServerIds);
		});

	const raw = await readFile(toolLogPath, "utf8");
	const mcpCalls = raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => String((JSON.parse(line) as { tool?: string }).tool ?? ""));

	const missingInMcp = diffMultiset(piCalls, mcpCalls);
	const missingInPi = diffMultiset(mcpCalls, piCalls);
	const orderMismatch =
		missingInMcp.length === 0 && missingInPi.length === 0 && JSON.stringify(piCalls) !== JSON.stringify(mcpCalls);

	// 提不出名字 = pi 的事件 schema 变了。见 ReconcileReport.schemaMismatch。
	const schemaMismatch = piCalls.some((name) => name.length === 0);
	// 两侧全空 = 什么都没比。见 ReconcileReport.vacuous。
	const vacuous = piCalls.length === 0 && mcpCalls.length === 0;

	return {
		ok: !schemaMismatch && !vacuous && missingInMcp.length === 0 && missingInPi.length === 0 && !orderMismatch,
		piCalls,
		mcpCalls,
		missingInMcp,
		missingInPi,
		orderMismatch,
		schemaMismatch,
		vacuous,
	};
}

/** a 里有、b 里不够的元素(按出现次数)。 */
function diffMultiset(a: string[], b: string[]): string[] {
	const remaining = new Map<string, number>();
	for (const name of b) remaining.set(name, (remaining.get(name) ?? 0) + 1);
	const out: string[] = [];
	for (const name of a) {
		const count = remaining.get(name) ?? 0;
		if (count > 0) {
			remaining.set(name, count - 1);
		} else {
			out.push(name);
		}
	}
	return out;
}
