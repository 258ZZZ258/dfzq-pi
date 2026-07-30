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
	let hasError = false;
	let detachPromise: Promise<void> | null = null;

	stream.on("error", (err) => {
		hasError = true;
		console.error(`Trajectory write error: ${err.message}`);
	});

	const unsubscribe = runtime.subscribe((event) => {
		if (!shouldRecord(event.type)) return;
		if (hasError) return; // Don't write if stream has errored
		stream.write(`${JSON.stringify(event)}\n`);
	});
	const detachFn = async () => {
		if (detachPromise) return detachPromise;
		detachPromise = (async () => {
			unsubscribe();
			// Check if stream is already closed (e.g., due to error or destroy)
			if (!stream.closed && !stream.writableEnded) {
				stream.end();
				await once(stream, "close");
			} else if (!stream.closed) {
				// Stream has writableEnded but not closed yet, wait for close
				await once(stream, "close");
			}
		})();
		return detachPromise;
	};
	// Expose stream for testing error scenarios (internal only)
	(detachFn as any).__stream = stream;
	return detachFn;
}

export async function readTrajectory(filePath: string): Promise<RuntimeEvent[]> {
	const raw = await readFile(filePath, "utf8");
	const events: RuntimeEvent[] = [];
	const lines = raw.split("\n");
	let malformedCount = 0;

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line) as RuntimeEvent);
		} catch (_err) {
			malformedCount++;
			console.error(`Failed to parse trajectory line: ${line.substring(0, 100)}...`);
		}
	}

	if (malformedCount > 0) {
		console.error(`Trajectory file had ${malformedCount} malformed lines`);
	}

	return events;
}
