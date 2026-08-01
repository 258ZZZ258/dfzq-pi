/**
 * 编排层隔离带。只放入口壳与观测层真正需要的东西。
 * 不得 import 任何 pi 类型 —— 否则实现细节会泄漏成公共契约。
 */

export type RunStatus = "completed" | "aborted" | "limit_exceeded" | "error";

export type LimitKind = "maxTurns" | "runTimeout" | "maxTotalTokens" | "maxCostUsd";

/**
 * 本 run 的限额状态。SessionRuntime 拥有它(run() 开头重置、runTimeoutMs 的 timer 写
 * tripped、归一化 RunResult 时读),limits 插件是另一个写方。放在 contract.ts 而不是
 * plugins/limits.ts:plugin-registry.ts 的 PluginContext 要引用它,而 registry 是通用
 * 设施,不该反向依赖某个具体插件。
 */
export interface LimitState {
	turns: number;
	tripped?: LimitKind;
}

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
	/**
	 * 每个终局判官实际重判了几次(判官名 → 次数)。没有判官时为空对象。
	 *
	 * 为什么要上到结果层:验收要区分「一次答对」与「靠重判才合规」——
	 * 只看 status=completed 是分不出来的,而后者说明 prompt 或工具描述有问题。
	 * 此前 runFinalJudges 算了这个数但被 session-runtime 整个丢弃,只有单测能观测到。
	 */
	judgeAttempts: Record<string, number>;
	/**
	 * **只在 `status === "completed"` 时才有此字段**:从 `output` 的 JSON 块提取,且仅在
	 * run 以 `completed` 收尾时提取——`status` 为 `error`(含 C6 输出契约判官
	 * `onExhausted:"error"` 判定失败的那一类,例如 basis 引用了臆造的 clause_id)/
	 * `limit_exceeded` / `aborted` 时,`output` 里即便能抠出语法合法的 JSON,也**不**填
	 * 进 `answer`——那份 JSON 没有通过 C6,不能被当成"已校验的应答"交给 Java(2026-07-31
	 * 复审 Important:早先这里写的是"C6 已校验的那个 JSON 对象",但代码从未检查 status,
	 * 被 C6 拒掉的臆造应答会原样进 answer;已在 toWireResult 里补上 status 闸门)。
	 *
	 * **给 Java 侧用**:`output` 是原始助手文本、带 markdown 围栏,消费方不该自己抠。
	 * 契约文档见 `packages/task-runtime/docs/java-answer-contract.md`。
	 *
	 * 类型是 `unknown` 而非具体形状:形状由**各 spec 自己的 outputContract schema** 决定,
	 * task-runtime 这一层不该固化某一个 spec 的形状。
	 *
	 * **提取不到时缺省**(output 无 JSON 块 / spec 未声明 outputContract)。run 已经完成了,
	 * 拿不到 answer 是降级不是失败 —— 这里绝不抛。
	 *
	 * **不在这一层重新校验 schema**:C6 是唯一真相源,再验一遍等于两处定义、必然漂移。
	 */
	answer?: unknown;
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
