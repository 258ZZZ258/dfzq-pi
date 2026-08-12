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
	 * **解析归 server/cli 入口做**(`src/spec/resolve-prompt-paths.ts` 的 `resolveSpecPromptPaths`,
	 * `server/main.ts` 的 `createDefaultRuntimeFactory` 与 `cli/main.ts` 都从这里 import 同一份
	 * 实现,不各写一份),不在这里,也不在 `assemble()` 里 —— `assemble()` 不知道 spec 是从哪个
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
	 * 追加到 `systemPrompt` 正文之后的条目列表。**每一项要么是字面文本、要么是文件路径**,
	 * 判据是"形似路径"的启发式(`resolve-prompt-paths.ts` 的 `looksLikePath()`,审查
	 * Important-5 裁定):含 `/`,或以 `.md` / `.json` 结尾 ⇒ 当路径处理,必须读得到,读不到
	 * 直接抛(错误信息与 `systemPrompt` 同构:spec id、字段名、原值、解析后的绝对路径);
	 * 不形似路径 ⇒ 原样当字面文本使用,不碰文件系统(`test/assembler.test.ts` 有直接传字面
	 * 文本给 `assemble()` 的用例,依赖这条继续成立——但那两条用例直接构造 `RuntimeSpec` 调
	 * `assemble()`,根本不经过这条解析,不受这里的判据变化影响)。
	 *
	 * ⚠️ **已知代价**:一段真的含 `/` 的字面文本(比如 "选 A/B 方案都可以")会被误判成路径,
	 * 文件不存在时会在构造期抛错,而不是被当字面文本兜底用掉。这是裁定认可的权衡——prompt
	 * 正文里出现这种形状的字面文本极少见,而"形似路径但拼错/文件不存在时静默退化成字面文本"
	 * 的代价大得多:出厂 spec 的输出契约正文正是走这个字段
	 * (`specs/policy-query.json` 的 `"appendSystemPrompt": ["policy-query/output-format.md"]`),
	 * 拼错路径会让契约悄悄从模型的 context 里消失、不报错。
	 *
	 * 这与 `systemPrompt` 的语义不同——`systemPrompt` 在出厂 spec 里只有"路径"这一种用法,
	 * 没有字面文本用例依赖它,所以无条件当路径处理、不需要"形似路径"这道判断;
	 * `appendSystemPrompt` 则必须保留字面文本这条路,所以多了 `looksLikePath()` 这一步。
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

	/**
	 * 非空时,本 spec 由**确定性工作流** runtime 驱动,而不是 SessionRuntime。
	 * 取值即工作流名,由 server/main.ts 的工厂分派。缺省 = SessionRuntime(agent 自主编排)。
	 *
	 * 与下面的 `fastPath` 是**两条不同的路**,不要混:`fastPath` 仍然走 SessionRuntime 的
	 * 那套装配(只是把模型调用压成固定 2 次、不达标就升级回 agent 自主编排);`workflow`
	 * 则整条换成另一个 `Runtime` 实现,连 SessionRuntime 都不经过。两者同时声明没有意义,
	 * 校验见 `validate.ts`。
	 */
	workflow?: "policy-compare" | "policy-version-diff";

	/** 缺省不填 = 不启用,既有 spec 行为不变。 */
	fastPath?: FastPathSpec;
}

/**
 * 快路径:模型调用次数固定为 2 次(先改写检索词,再对代码检索好的正文一次作答)。
 * 缺省不填 = 不启用,既有 spec 行为不变。产出不达标时升级回既有的 agent 自主编排路径 ——
 * 升级判定与两次模型调用的编排由后续任务实现,本接口这里只声明配置,不做调度。
 *
 * **不另起 spec 文件**:`src/router/router.ts` 的 `SpecRouter` 构造函数(12-19 行)保证
 * taskKind → spec 1:1(重复 id 装配期抛);`loadSpecRouter`(40-52 行)按目录下每个 `.json`
 * 文件各自 parse 出一个 spec,一个文件对应一个 taskKind。另起文件会凭空多出一个 Java 不会调的
 * taskKind。
 */
export interface FastPathSpec {
	enabled: boolean;
	/**
	 * 快路径的 system prompt,**文件路径**(与 `RuntimeSpec.systemPrompt` 同一套语义:
	 * 无条件当路径处理,构造期读成正文,读不到直接抛)。
	 *
	 * ⚠ 必须**中性**:两次模型调用共用同一个 AgentSession ⇒ 共用同一份 system prompt。
	 * 把输出契约写进这里,模型①(改写检索词那次)会直接吐 JSON 而不是改写词。
	 * 输出契约放 `answerPrompt`。
	 */
	systemPrompt: string;
	/** 模型① 的 user 消息模板,文件路径,同 `systemPrompt` 的路径语义。 */
	rewritePrompt: string;
	/** 模型② 的 user 消息模板(含输出契约正文),文件路径,同 `systemPrompt` 的路径语义。 */
	answerPrompt: string;
	/** 取正文的 clause_id 条数上限。 */
	maxClauses: number;
	/** 快路径自己的限额。`maxTurns` 不适用(结构固定 2 次模型调用)。 */
	limits: RuntimeLimits;
	/** 缺省沿用 `RuntimeSpec.thinkingLevel`。 */
	thinkingLevel?: ThinkingLevel;
	/** 覆盖 C4 result-budget 的 `maxChars`。 */
	maxChars?: Record<string, number>;
}

export function pluginName(ref: PluginRef): string {
	return typeof ref === "string" ? ref : ref.name;
}

export function pluginOptions(ref: PluginRef): Record<string, unknown> | undefined {
	return typeof ref === "string" ? undefined : ref.options;
}
