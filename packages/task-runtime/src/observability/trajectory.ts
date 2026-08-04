import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Runtime, RuntimeEvent } from "../runtime/contract.ts";

/**
 * 落盘白名单。token 级 delta 之类的高频噪声不记。
 *
 * 导出复用:serve 侧的事件落库(`server/run-manager.ts`)判「这条事件要不要记」用的是同一份
 * 白名单,不是另发明一套 —— 两套白名单会漂移(task-18b)。
 *
 * 往这里加类型之前先看 `run-manager.ts` 的逐条写:这份白名单现在同时服务两个成本完全不同的
 * 消费方——trajectory 这边是缓冲写流,加一个类型基本免费;`run-manager.ts` 那边是每条事件一次
 * 同步 `appendEvents`(`BEGIN`/`COMMIT` 各一次)。哪天有人为了 trajectory 好看加了
 * `message_update` 之类的高频类型,会变成 serve 路径每个 token 一次同步 DB 事务。
 */
export const RECORDED_TYPES: ReadonlySet<string> = new Set([
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"compaction_start",
	"compaction_end",
	"agent_end",
	"entry_appended",
	// `fast-path-runtime.ts` 在每次升级(verdict.accept===false)时发一次。上面这段警告针对
	// 的是**高频**类型(token 级 delta 那种,每个 token 一次同步 DB 事务);这一条每个 run
	// 最多发一次(runFast() 一条调用路径只可能落进一个升级分支就返回),成本与 turn_end /
	// agent_end 同一量级,不是警告要拦的那类。缺它的后果是实的:规格 §8.1 判据 2("升级率
	// 如实记录")在这条不落库之前没有任何可查询的凭证通路——`fast_path_escalated` 会被
	// `shouldRecord()` 拦下,`attachTrajectory` 与 `run-manager.ts` 都按这份白名单过滤。
	"fast_path_escalated",
]);

export function shouldRecord(type: string): boolean {
	return RECORDED_TYPES.has(type) || type.startsWith("auto_retry_");
}

/** Optional configuration for attachTrajectory (primarily for testing) */
interface AttachTrajectoryOptions {
	onStreamCreated?: (stream: WriteStream) => void;
}

export async function attachTrajectory(
	runtime: Runtime,
	filePath: string,
	options?: AttachTrajectoryOptions,
): Promise<() => Promise<void>> {
	await mkdir(dirname(filePath), { recursive: true });
	const stream: WriteStream = createWriteStream(filePath, { flags: "a" });
	let hasError = false;
	let detachPromise: Promise<void> | null = null;

	stream.on("error", (err) => {
		hasError = true;
		console.error(`Trajectory write error: ${err.message}`);
	});

	// Allow tests to inject error scenarios via callback
	if (options?.onStreamCreated) {
		options.onStreamCreated(stream);
	}

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
