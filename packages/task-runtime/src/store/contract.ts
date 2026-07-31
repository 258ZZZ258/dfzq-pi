/**
 * 存储层接口。换 PG 时上层不动(设计文档 §5.7)。
 * 不得 import 任何 pi 类型 —— 与 runtime/contract.ts 同一条隔离带纪律。
 */
import type { LimitKind, RunResult } from "../runtime/contract.ts";

/** 比 contract.ts 的 RunStatus 多 queued / running 两个非终态。 */
export type StoredRunStatus = "queued" | "running" | "completed" | "aborted" | "limit_exceeded" | "error";

export interface RunRecord {
	runId: string;
	clientRequestId: string;
	requestId?: string;
	specId: string;
	taskKind: string;
	sessionId: string;
	/** ★ Java jCasbin 预计算的授权位,原样存档,不解析后再存(设计文档 §5.7)。 */
	filtersJson: string;
	optionsJson?: string;
	status: StoredRunStatus;
	input: string;
	output?: string;
	errorMessage?: string;
	stopReason?: string;
	limitHit?: LimitKind;
	usageJson?: string;
	turns?: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export type NewRun = Omit<
	RunRecord,
	"status" | "output" | "errorMessage" | "stopReason" | "limitHit" | "usageJson" | "turns" | "startedAt" | "finishedAt"
>;

export interface StoredEvent {
	seq: number;
	ts: number;
	type: string;
	/** 已序列化、已脱敏。 */
	payload: string;
}

export interface RunStore {
	/**
	 * 原子幂等。INSERT ... ON CONFLICT(client_request_id) DO NOTHING,
	 * changes===1 → inserted:true;否则按 clientRequestId 读出既有行返回 inserted:false。
	 *
	 * 不用 try/catch 捕 UNIQUE 违约:设计文档 §4.1 画的「先 SELECT 再 INSERT」在并发同键下
	 * 会双双 miss 再双双 INSERT,一个吃约束违约并冒成 500。
	 */
	insertQueued(rec: NewRun): { inserted: boolean; run: RunRecord };
	findByRunId(runId: string): RunRecord | undefined;
	markRunning(runId: string, startedAt: number): void;
	finish(runId: string, result: RunResult, finishedAt: number): void;
	markError(runId: string, message: string, finishedAt: number): void;
	/**
	 * 按主键删除该行。语义是「撤销 insertQueued 的原子占用」——目前唯一调用方是
	 * RunManager.submit() 的闸门拒绝分支:insertQueued 原子占了 clientRequestId 唯一索引,
	 * 但闸门随后拒绝时不该把这次尝试钉成终态行,而是把幂等键还给客户端,让同一
	 * clientRequestId 重试时能重新走 insertQueued(设计裁定,见 run-manager.ts submit() 的
	 * 拒绝分支注释)。删不到行(runId 不存在)不抛——拒绝路径是唯一调用方,不存在的行
	 * 意味着别的路径已经先一步清理掉了,吞掉比抛错更安全。
	 */
	deleteRun(runId: string): void;
	/** 启动时 status IN ('queued','running') → error,返回受影响行数。 */
	recoverStaleRuns(now: number): number;
	appendEvents(runId: string, events: StoredEvent[]): void;
	close(): void;
}
