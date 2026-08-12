import { randomUUID } from "node:crypto";
import type { RuntimeSpec } from "../../spec/types.ts";
import type { RunOptions, RunResult, Runtime, RuntimeEvent } from "../contract.ts";
import type { DocumentsClient } from "./documents-client.ts";
import type { VersionDiffPayload, VersionDiffResult } from "./types.ts";

export interface VersionDiffRuntimeOptions {
	spec: RuntimeSpec;
	payload: unknown;
	documents: DocumentsClient;
	permissionTags: string[];
}

export function parseVersionDiffPayload(raw: unknown): VersionDiffPayload {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("payload 必须是 JSON 对象");
	}
	const payload = raw as Record<string, unknown>;
	const newDocVersionId = payload.newDocVersionId;
	const oldDocVersionId = payload.oldDocVersionId;
	if (typeof newDocVersionId !== "string" || newDocVersionId === "") {
		throw new Error("payload.newDocVersionId 必填且必须是非空字符串");
	}
	if (typeof oldDocVersionId !== "string" || oldDocVersionId === "") {
		throw new Error("payload.oldDocVersionId 必填且必须是非空字符串");
	}
	if (newDocVersionId === oldDocVersionId) {
		throw new Error("payload.newDocVersionId 与 oldDocVersionId 必须不同");
	}
	return { newDocVersionId, oldDocVersionId };
}

/**
 * 同一逻辑制度的版本 diff 不调用模型：audit-ai 以条款路径精确对齐，runtime 只负责
 * 鉴权透传、进度事件和统一的 `/runs` 输出外壳。这样不会让 LLM 重新解释或篡改差异。
 */
export function createVersionDiffRuntime(options: VersionDiffRuntimeOptions): Runtime {
	const payload = parseVersionDiffPayload(options.payload);
	if (!options.documents.compareVersions) {
		throw new Error("DocumentsClient 未实现 compareVersions，无法执行版本差异比对");
	}
	const id = randomUUID();
	const sessionId = `policy-version-diff-${id}`;
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let running: Promise<RunResult> | undefined;
	let aborted = false;
	let disposed = false;
	let lastActiveAt = Date.now();
	let seq = 0;

	function emit(runId: string, type: string, payloadOut: unknown): void {
		for (const listener of listeners) {
			listener({ runId, specId: options.spec.id, seq: ++seq, ts: Date.now(), type, payload: payloadOut });
		}
	}

	return {
		id,
		specId: options.spec.id,
		sessionId,
		async run(_input: string, runOptions: RunOptions = {}): Promise<RunResult> {
			if (disposed) throw new Error("VersionDiffRuntime 已释放");
			if (running) throw new Error("VersionDiffRuntime 正在运行");
			aborted = false;
			const runId = runOptions.runId ?? randomUUID();
			const startedAt = Date.now();
			lastActiveAt = startedAt;
			running = (async () => {
				emit(runId, "compare_stage", { stage: "loading_versions", percent: 20, message: "正在读取新旧版本条款" });
				try {
					const answer: VersionDiffResult = await options.documents.compareVersions!({
						newDocVersionId: payload.newDocVersionId,
						oldDocVersionId: payload.oldDocVersionId,
						permTags: options.permissionTags,
					});
					if (aborted) {
						return terminal(runId, "aborted", startedAt, "版本差异比对已取消");
					}
					emit(runId, "compare_stage", { stage: "assembling", percent: 100, message: "已完成条款差异汇总" });
					return {
						runId,
						specId: options.spec.id,
						status: "completed",
						output: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
						turns: 0,
						durationMs: Date.now() - startedAt,
						judgeAttempts: {},
						answer,
					};
				} catch (cause) {
					return terminal(runId, "error", startedAt, cause instanceof Error ? cause.message : String(cause));
				} finally {
					lastActiveAt = Date.now();
				}
			})();
			try {
				return await running;
			} finally {
				running = undefined;
			}
		},
		async steer(): Promise<void> {
			throw new Error("VersionDiffRuntime 不支持 steer(确定性工作流无插话语义)");
		},
		async followUp(): Promise<void> {
			throw new Error("VersionDiffRuntime 不支持 followUp(确定性工作流无插话语义)");
		},
		async abort(): Promise<void> {
			aborted = true;
		},
		async waitForIdle(): Promise<void> {
			if (running) await running;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get isIdle() {
			return running === undefined;
		},
		get lastActiveAt() {
			return lastActiveAt;
		},
		snapshot() {
			return { sessionId };
		},
		async dispose(): Promise<void> {
			disposed = true;
			listeners.clear();
		},
	};
}

function terminal(runId: string, status: "aborted" | "error", startedAt: number, errorMessage: string): RunResult {
	return {
		runId,
		specId: "policy-compare-version-diff",
		status,
		errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		turns: 0,
		durationMs: Date.now() - startedAt,
		judgeAttempts: {},
	};
}
