import { readFile } from "node:fs/promises";
import type { StoredEvent } from "../store/contract.ts";
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

/** pi 侧事件的最小形状 —— `RuntimeEvent`(trajectory 路径)与「JSON.parse 过的
 *  `StoredEvent.payload`」(run_events 路径)都满足这个形状,`extractPiCalls` 不关心
 *  事件是从文件读的还是从表里读的。 */
interface PiSideEvent {
	type: string;
	payload: unknown;
}

/** 从 pi 侧事件里挑出 `tool_execution_end`,提工具名。两条数据源(trajectory JSONL /
 *  run_events 表)共用这份提取逻辑,不各自维护一份,避免今后两边判据慢慢漂移。 */
function extractPiCalls(events: PiSideEvent[], knownServerIds?: string[]): string[] {
	return events
		.filter((event) => event.type === "tool_execution_end")
		.map((event) => {
			const payload = event.payload;
			if (typeof payload !== "object" || payload === null) return "";
			const toolName = String((payload as { toolName?: string }).toolName ?? "");
			return stripServerPrefix(toolName, knownServerIds);
		});
}

async function readMcpCalls(toolLogPath: string): Promise<string[]> {
	const raw = await readFile(toolLogPath, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => String((JSON.parse(line) as { tool?: string }).tool ?? ""));
}

/** piCalls/mcpCalls 提出来之后,两条数据源共用同一份比对与报告组装逻辑。 */
function buildReport(piCalls: string[], mcpCalls: string[]): ReconcileReport {
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

/** CLI/eval 路径:pi 侧数据源是 `attachTrajectory` 写的 trajectory JSONL 文件。 */
export async function reconcile(
	trajectoryPath: string,
	toolLogPath: string,
	knownServerIds?: string[],
): Promise<ReconcileReport> {
	const events = await readTrajectory(trajectoryPath);
	const piCalls = extractPiCalls(events, knownServerIds);
	const mcpCalls = await readMcpCalls(toolLogPath);
	return buildReport(piCalls, mcpCalls);
}

/**
 * serve 路径(task-18b 复审 Important-3):pi 侧数据源是 `RunStore.appendEvents` 落库的
 * `run_events`,由调用方先 `store.listEvents(runId)` 读出再传进来 —— 本函数不持有
 * `RunStore`,保持 observability 层不反向依赖 store 层的实现,只依赖 `StoredEvent` 这个
 * 数据形状。
 *
 * `StoredEvent.payload` 是脱敏投影序列化后的 JSON 串(`server/run-manager.ts` 的
 * `toStoredEvent`),这里只做 `JSON.parse` 把它变回对象,**不改投影**——脱敏后的
 * `{type, seq, ts, toolName, isError}` 里的 `toolName` 字段名与 trajectory 路径读到的
 * pi 原始事件一致,`extractPiCalls` 不需要为这条数据源另写一份字段映射。
 */
export async function reconcileRunEvents(
	storedEvents: StoredEvent[],
	toolLogPath: string,
	knownServerIds?: string[],
): Promise<ReconcileReport> {
	const events: PiSideEvent[] = storedEvents.map((event) => ({
		type: event.type,
		payload: JSON.parse(event.payload) as unknown,
	}));
	const piCalls = extractPiCalls(events, knownServerIds);
	const mcpCalls = await readMcpCalls(toolLogPath);
	return buildReport(piCalls, mcpCalls);
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
