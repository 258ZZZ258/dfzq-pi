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
}

/** 多 server 同名时 adapter 会加 "<serverId>__" 前缀,对账时剥掉。 */
function stripServerPrefix(name: string): string {
	const index = name.indexOf("__");
	return index >= 0 ? name.slice(index + 2) : name;
}

export async function reconcile(trajectoryPath: string, toolLogPath: string): Promise<ReconcileReport> {
	const events = await readTrajectory(trajectoryPath);
	const piCalls = events
		.filter((event) => event.type === "tool_execution_end")
		.map((event) => stripServerPrefix(String((event.payload as { toolName?: string }).toolName ?? "")));

	const raw = await readFile(toolLogPath, "utf8");
	const mcpCalls = raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => String((JSON.parse(line) as { tool?: string }).tool ?? ""));

	const missingInMcp = diffMultiset(piCalls, mcpCalls);
	const missingInPi = diffMultiset(mcpCalls, piCalls);
	const orderMismatch =
		missingInMcp.length === 0 && missingInPi.length === 0 && JSON.stringify(piCalls) !== JSON.stringify(mcpCalls);

	return {
		ok: missingInMcp.length === 0 && missingInPi.length === 0 && !orderMismatch,
		piCalls,
		mcpCalls,
		missingInMcp,
		missingInPi,
		orderMismatch,
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
