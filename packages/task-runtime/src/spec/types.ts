export type PluginRef = string | { name: string; options?: Record<string, unknown> };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeLimits {
	maxTurns?: number;
	runTimeoutMs?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
}

export interface CompactionSpec {
	enabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface ObservabilitySpec {
	contextSnapshot?: "off" | "hash" | "sampled" | "full";
	snapshotSampleEveryNTurns?: number;
	redact?: string[];
}

export interface OutputContractSpec {
	/** JSON Schema 文件路径(相对 spec 文件所在目录,或绝对路径)。 */
	schema: string;
	/** 允许的退回重试次数,默认 2。 */
	maxRepairAttempts?: number;
}

export interface RuntimeSpec {
	id: string;
	description?: string;

	/** 角色引用,由 ProviderProfile 解析成具体模型。任务属性,与环境无关。 */
	model: { role: string };
	thinkingLevel?: ThinkingLevel;

	toolset: string;
	/** 必填白名单。pi 的 noTools:"all" 不填 tools 等于工具全关(sdk.ts:246,249-251)。 */
	tools: string[];
	excludeTools?: string[];

	systemPrompt?: string;
	appendSystemPrompt?: string[];

	compaction?: CompactionSpec;
	contextStrategy?: PluginRef;

	/** pi 无此概念,本层实现。 */
	limits: RuntimeLimits;

	stopPolicy?: PluginRef;
	resultPolicy?: PluginRef;
	approvalPolicy?: PluginRef;
	extraPlugins?: PluginRef[];

	/**
	 * ⚠️ S0 未接线,S2 实现。装配期接受该字段但**不做任何事**,也不会报错 ——
	 * 现在填它不会改变任何行为。S2 的事件管道/快照落盘落地时才会真正消费。
	 * (S0 只把 appendSystemPrompt 这类"声明了却静默失效"的字段补齐;observability
	 * 依赖 S2 才有的观测组件,所以显式标注而不是假装接上。)
	 */
	observability?: ObservabilitySpec;

	/** 缺省即不挂 C6(输出契约判官)—— 既有 spec 的行为不变。 */
	outputContract?: OutputContractSpec;
}

export function pluginName(ref: PluginRef): string {
	return typeof ref === "string" ? ref : ref.name;
}

export function pluginOptions(ref: PluginRef): Record<string, unknown> | undefined {
	return typeof ref === "string" ? undefined : ref.options;
}
