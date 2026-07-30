import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Runtime, RuntimeEvent } from "../runtime/contract.ts";

/** 落盘白名单。token 级 delta 之类的高频噪声不记。 */
const RECORDED_TYPES: ReadonlySet<string> = new Set([
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"compaction_start",
	"compaction_end",
	"agent_end",
	"entry_appended",
]);

function shouldRecord(type: string): boolean {
	return RECORDED_TYPES.has(type) || type.startsWith("auto_retry_");
}

export async function attachTrajectory(runtime: Runtime, filePath: string): Promise<() => Promise<void>> {
	await mkdir(dirname(filePath), { recursive: true });
	const stream: WriteStream = createWriteStream(filePath, { flags: "a" });
	const unsubscribe = runtime.subscribe((event) => {
		if (!shouldRecord(event.type)) return;
		stream.write(`${JSON.stringify(event)}\n`);
	});
	return async () => {
		unsubscribe();
		stream.end();
		await once(stream, "close");
	};
}

export async function readTrajectory(filePath: string): Promise<RuntimeEvent[]> {
	const raw = await readFile(filePath, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RuntimeEvent);
}
