/**
 * 编排层隔离带。只放入口壳与观测层真正需要的东西。
 * 不得 import 任何 pi 类型 —— 否则实现细节会泄漏成公共契约。
 */

export type RunStatus = "completed" | "aborted" | "limit_exceeded" | "error";

export type LimitKind = "maxTurns" | "runTimeout" | "maxTotalTokens" | "maxCostUsd";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface RunResult {
	runId: string;
	/** 产生本次 run 的 RuntimeSpec.id。与 RuntimeEvent.specId 同源,让结果与事件流对得上;
	 *  设计文档的 runs 表和 S3 池的 get(specId, sessionId?) 都靠它关联。 */
	specId: string;
	status: RunStatus;
	output?: string;
	errorMessage?: string;
	stopReason?: string;
	limit?: LimitKind;
	usage: RunUsage;
	turns: number;
	durationMs: number;
}

export interface RuntimeSnapshot {
	sessionId: string;
	sessionFile?: string;
}

export interface RuntimeEvent {
	runId: string;
	specId: string;
	seq: number;
	ts: number;
	type: string;
	payload: unknown;
}

export interface RunOptions {
	runId?: string;
}

export interface Runtime {
	readonly id: string;
	readonly specId: string;
	readonly sessionId: string;

	run(input: string, opts?: RunOptions): Promise<RunResult>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;

	subscribe(listener: (event: RuntimeEvent) => void): () => void;

	readonly isIdle: boolean;
	readonly lastActiveAt: number;
	snapshot(): RuntimeSnapshot;
	dispose(): Promise<void>;
}
