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

	/**
	 * 系统提示,**文件路径,相对 spec 文件所在目录解析**(与 `outputContract.schema` / `skills`
	 * 同一套路径语义)。不是字面文本,也不支持 `@` 前缀 —— pi 的 `@file` 语法只用于 CLI 的
	 * `fileArgs`(coding-agent/src/cli/args.ts,「@file 提及」那个功能),与 `--system-prompt`
	 * / 本字段无关;写成 `"@specs/xxx.md"` 只会让路径本身多一段永远不存在的 `@specs` 目录,
	 * 解析必然落空(task-15d 的根因)。
	 *
	 * **解析归 server/cli 入口做**(`createDefaultRuntimeFactory` 的 `resolveSpecPromptPaths`
	 * / `cli/main.ts`),不在这里,也不在 `assemble()` 里 —— `assemble()` 不知道 spec 是从哪个
	 * 目录读出来的,与 `skills` / `outputContract.schema` 同一条既有纪律。
	 *
	 * 构造期就要把文件**读成正文**,读不到直接抛,而不是只把解析出的绝对路径丢给 pi:pi 的
	 * `resolvePromptInput`(coding-agent/src/core/resource-loader.ts:53-67)是
	 * `existsSync(input) ? readFileSync(input) : input` —— 路径读不到就把路径字符串本身当
	 * prompt 正文,不抛也不告警。`spec.systemPrompt` 自 3dc0d28c 起从未生效过,根因就是
	 * task-runtime 曾经只算路径不读文件,让这条静默 fallthrough 把路径字符串送给了模型。
	 */
	systemPrompt?: string;
	/**
	 * 随本 spec 注入的 skill 文件路径,**相对 spec 文件所在目录**解析(与 `outputContract.schema`
	 * 同一套路径语义)。
	 *
	 * 走 pi 的 `DefaultResourceLoader.additionalSkillPaths`,与 `noSkills: true` **不冲突** ——
	 * `noSkills` 只过滤磁盘扫描出来的 skill,不挡构造选项传进来的(resource-loader.ts:467-469)。
	 * 底座保持「剥光通用能力」,任务需要的能力由任务自己声明。
	 *
	 * 为什么不并进 `appendSystemPrompt`:那样每轮都会全量常驻整篇正文,而正规 skill loader
	 * 只常驻 name/description 摘要,正文由模型按需 Read。两者对 context 的占用不是一个量级。
	 */
	skills?: string[];
	/**
	 * 追加到 `systemPrompt` 正文之后的条目列表。**每一项要么是字面文本、要么是文件路径**——
	 * 判据是 `resolve(specsDir, item)` 是否存在:存在就当路径读成正文,不存在就原样当字面
	 * 文本使用(`test/assembler.test.ts` 有直接传字面文本给 `assemble()` 的用例,依赖这条
	 * 兜底继续成立)。这与 `systemPrompt` 的语义不同 —— `systemPrompt` 在出厂 spec 里只有
	 * "路径"这一种用法,没有字面文本用例依赖它,所以无条件当路径处理、读不到就抛;
	 * `appendSystemPrompt` 则必须保留字面文本这条路。
	 *
	 * 路径解析同样**相对 spec 文件所在目录**,同样由 server/cli 入口做(见 `systemPrompt` 的
	 * 说明),`assemble()` 不知道 spec 从哪来。
	 */
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
