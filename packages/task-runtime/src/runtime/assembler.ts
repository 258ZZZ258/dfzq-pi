import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ProviderProfile, profileRoles, requireApiKey, resolveRole } from "../env/provider-profile.ts";
import { type PluginRef, pluginName, type RuntimeSpec } from "../spec/types.ts";
import { validateSpec } from "../spec/validate.ts";
import type { ToolsetRegistry } from "../toolsets/registry.ts";
import { instantiatePlugins, type PluginContext, type PluginEntry, type PluginRegistry } from "./plugin-registry.ts";
import { LIMITS_PLUGIN_NAME, type LimitsOptions } from "./plugins/limits.ts";

/**
 * Task 18c:`callTool`(下面 :163 起)打给一次插件驱动的工具调用发一次「开始」、一次
 * 「结束」的合成事件,喂给 `AssembleOptions.emitPluginToolEvent`。形状照抄 pi 的
 * `ToolExecutionStartEvent` / `ToolExecutionEndEvent`,但**只留 `toolName`(结束事件再加
 * `isError`)**——不带 `args`/`result`。这与 18b 落库前脱敏投影的白名单
 * (`server/run-manager.ts` 的 `toStoredEvent`:工具名 · isError · 事件类型 · seq · ts)
 * 是同一条纪律:调用参数可能是检索词、返回体可能是制度条款正文,`_audit`「只记标识不记内容」
 * 那条规矩对合成事件同样成立,不能指望下游落库时再帮它脱一次敏。
 */
export type PluginToolCallEvent =
	| { type: "tool_execution_start"; toolName: string }
	| { type: "tool_execution_end"; toolName: string; isError: boolean };

export interface AssembleOptions {
	spec: RuntimeSpec;
	profile: ProviderProfile;
	registry: PluginRegistry;
	toolsets: ToolsetRegistry;
	cwd: string;
	agentDir: string;
	/**
	 * `spec.skills` 解析成的**绝对**路径。与 `outputContractSchema` 同一条纪律:
	 * 相对路径的基准是 spec 文件所在目录,而 assemble() 不知道 spec 从哪来 ——
	 * 所以解析归调用方(`createDefaultRuntimeFactory` / `cli/main.ts`)。
	 */
	skillPaths?: string[];
	/**
	 * 本次装配的 per-run 上下文。**不含 `callTool`** —— 那一项只有 assemble() 造得出
	 * (它同时握着已解析的工具与待实例化的插件),由本函数补齐后再交给插件工厂。
	 */
	pluginContext: Omit<PluginContext, "callTool">;
	/** 测试缝:绕过 ProviderProfile,直接用已注册的 faux 模型 */
	modelOverride?: {
		modelRuntime: ModelRuntime;
		model: NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
	};
	/**
	 * Task 18c:插件经 `PluginContext.callTool` 发起的调用直接打 `tool.execute(...)`,
	 * 绕过 pi 的 agent loop —— 不产生 `tool_execution_*` 事件,`run_events` 看不到,MCP 侧
	 * 审计日志却记得到(C3 `sufficiency-gate` 判官的探针调用正是这样漏出 A6 对账缺口的)。
	 *
	 * 这个回调由 `session-runtime.ts` 提供(它握着 `Runtime.subscribe()` 的 `listeners`
	 * 集合与那个单调 `seq` 计数器),`callTool` 在调用前后各发一次,由调用方补上 `RuntimeEvent`
	 * 的信封(runId/specId/seq/ts)。
	 *
	 * 🔴 **硬性设计约束**:这条回调只能接到 `listeners`,绝不能接进 pi 的
	 * `session.subscribe()` 那条通路 —— 那条是 C6 反幻觉校验 `collectClauseIds` 的数据源。
	 * 若插件探针取回的内容也算进 `clauseIds`,等于扩大了模型可合法引用的 clause_id 集合、
	 * 削弱反幻觉兜底;这条回调的职责仅仅是补观测,不改 C6 语义。约束是否守住由
	 * `session-runtime.ts` 那侧的接线负责,这里只负责"调用前后各发一次、不多发字段"。
	 *
	 * 缺省时(比如测试直接调 `assemble()` 且不关心事件流)`callTool` 静默跳过发射。
	 */
	emitPluginToolEvent?: (event: PluginToolCallEvent) => void;
}

export interface Assembled {
	session: AgentSession;
	specId: string;
	/**
	 * 本次装配的资源加载器。暴露它只为**可观测** —— 「spec 声明的 skill 到底加载上没有」
	 * 除了 `getSkills()` 没有别的验法(skill 不是工具,不出现在 getActiveToolNames 里,
	 * 它只影响 system prompt 里的 `<available_skills>` 摘要)。
	 */
	resources: DefaultResourceLoader;
	/**
	 * 不经 agent loop 直接调本次装配的工具。与 `PluginContext.callTool` **是同一个函数**
	 * (assemble() 内部只造一次),所以合成事件、未知工具名的响亮报错都一致。
	 *
	 * 两个消费方,都是「模型看不见工具、检索由代码发起」的形态:`FastPathRuntime`(阶段 1
	 * 的检索)与 `PolicyCompareRuntime`(阶段 2/3 的 M1/M2 调用)。
	 *
	 * 🔴 与 `emitPluginToolEvent` 那条硬性约束的关系:那条说的是「callTool 的结果不得进
	 * C6 的 clauseIds」,针对的是**插件探针**(探针取回的东西不是模型的证据)。上面两个
	 * 消费方不同 —— 代码取回并拼进模型 prompt 的**就是**模型的证据,所以它们**各自维护
	 * 自己的证据集合**,只收真正拼进 prompt 的那批。那条约束本身不动。
	 */
	callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	dispose: () => Promise<void>;
}

/**
 * 从工具结果里取文本。
 *
 * pi 的 `AgentToolResult.content` 类型是 `(TextContent | ImageContent)[]`,但**测试 fixture
 * 里普遍写成裸字符串**(`test/helpers` 与几个 `*.test.ts` 的 echo,第一刀台账 §6.1 记为
 * 「fixture 自相矛盾」的 deferred minor)。两种形状都要认:只认数组会让所有用 fixture 的
 * 插件测试拿到空串,只认字符串会在生产上炸 —— 后者正是第一刀 C4 踩过的坑
 * (类型断言压过去 ⇒ 运行时 `content.trim()` 抛 TypeError,而 pi 的 emitToolResult
 * catch 住并悄悄丢弃,整个插件在生产上静默失效)。
 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
		)
		.join("");
}

function formatNames(names: readonly string[]): string {
	return names.length > 0 ? names.map((name) => `"${name}"`).join(", ") : "(none)";
}

export async function assemble(options: AssembleOptions): Promise<Assembled> {
	const { spec, profile, registry, toolsets, cwd, agentDir } = options;

	validateSpec(spec, {
		knownToolsets: toolsets.ids(),
		knownPlugins: registry.names(),
		knownRoles: profileRoles(profile),
	});

	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

	const { modelRuntime, model } = options.modelOverride ?? (await resolveModel(spec, profile, agentDir));

	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: spec.compaction?.enabled ?? true,
			reserveTokens: spec.compaction?.reserveTokens ?? 16384,
			keepRecentTokens: spec.compaction?.keepRecentTokens ?? 20000,
		},
	});

	// resolve() 打开的句柄(比如 MCP 子进程)从这里开始是本次 run 独占的:谁开的谁关,
	// 装配失败也不能让它泄漏(下面的 try/catch)。Registry 本身不再追踪它——见
	// toolsets/registry.ts 的改动说明。这条不变量覆盖 resolve() 成功之后到 return 之前
	// 的*所有*代码,所以下面的工具名交叉校验也必须在 try 块里——它和 createAgentSession
	// 一样是"resolve() 之后才可能失败的东西",挪出 try 块就是又复现一次 handle 泄漏。
	const { tools, dispose: disposeToolset } = await toolsets.resolve(spec.toolset);

	try {
		// 装配期失败要早:pi 的 setActiveToolsByName 对不认识的工具名是静默丢弃,不抛错
		// (agent-session.ts),所以这里必须自己做交叉校验,不能指望 createAgentSession 帮忙。
		const availableToolNames = new Set(tools.map((tool) => tool.name));
		const unknownTools = spec.tools.filter((name) => !availableToolNames.has(name));
		if (unknownTools.length > 0) {
			throw new Error(
				`RuntimeSpec "${spec.id}": tools whitelist references unknown tool(s) ${formatNames(unknownTools)} ` +
					`from toolset "${spec.toolset}" (available: ${formatNames([...availableToolNames])})`,
			);
		}
		const unknownExcludedTools = (spec.excludeTools ?? []).filter((name) => !availableToolNames.has(name));
		if (unknownExcludedTools.length > 0) {
			throw new Error(
				`RuntimeSpec "${spec.id}": excludeTools references unknown tool(s) ${formatNames(unknownExcludedTools)} ` +
					`from toolset "${spec.toolset}" (available: ${formatNames([...availableToolNames])})`,
			);
		}

		const specPluginRefs: PluginRef[] = [
			...(spec.contextStrategy ? [spec.contextStrategy] : []),
			...(spec.stopPolicy ? [spec.stopPolicy] : []),
			...(spec.resultPolicy ? [spec.resultPolicy] : []),
			...(spec.approvalPolicy ? [spec.approvalPolicy] : []),
			...(spec.extraPlugins ?? []),
		];
		// limits 现在是 registry 里一个**可解析的名字**,于是 `extraPlugins: ["limits"]` 之类
		// 的声明能通过 validateSpec(它只查 knownPlugins),再被下面的 lookupAll 解析成第二个
		// 条目。turn_end 是观察型 hook,替换型冲突校验不拦它 —— 两个实例共享同一个
		// ctx.limitState、各自 `state.turns += 1`,于是 maxTurns:5 在第 3 个真实回合就触发。
		// 这是限额子系统自身的静默错判,必须在装配期响亮拒绝。
		// **不做静默去重**:悄悄丢掉重复项会让写错 spec 的人永远不知道自己写错了。
		const duplicateLimits = specPluginRefs.find((ref) => pluginName(ref) === LIMITS_PLUGIN_NAME);
		if (duplicateLimits) {
			throw new Error(
				`RuntimeSpec "${spec.id}": "${LIMITS_PLUGIN_NAME}" is mounted implicitly from spec.limits ` +
					`and must not be declared as a plugin ref`,
			);
		}

		// limits 由 spec.limits 字段驱动,不是 spec 声明的 PluginRef,所以在这里无条件
		// 挂上。它和 spec 声明的插件走同一张表、同一次冲突校验 —— 不存在"内置插件绕过
		// 替换型 hook 保护"的缝。
		// registry 里没有 limits 会在这里直接抛 `plugin "limits" is not registered`。
		// 这是刻意的:唯一合法的 registry 来源是 createDefaultPluginRegistry()。
		// (validateSpec 看不到这个隐式 ref,所以报错点是 lookupAll 而不是 validateSpec。)
		const pluginEntries: PluginEntry[] = registry.lookupAll([
			{ name: LIMITS_PLUGIN_NAME, options: { limits: spec.limits } satisfies LimitsOptions },
			...specPluginRefs,
		]);
		// callTool 在这里补上而不是让调用方给:只有 assemble() 同时握着「已解析的工具」
		// 与「要实例化的插件」。tools 来自上面的 toolsets.resolve()(:70),插件在 :122
		// 才实例化 —— 时序成立。
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const pluginContext: PluginContext = {
			...options.pluginContext,
			callTool: async (name, args) => {
				const tool = byName.get(name);
				if (!tool) {
					// 装配错误要响要早:插件声明了依赖某工具,而 spec 的 toolset 没提供它。
					// 工具从未被调用,不发合成事件 —— 没有发生过的执行没有事件可报。
					throw new Error(
						`Plugin requested tool "${name}", which this run's toolset does not provide ` +
							`(available: ${formatNames([...byName.keys()])})`,
					);
				}
				// Task 18c:这次调用打到真实 MCP server(审计日志记得到),但 tool.execute()
				// 直接调、绕过 pi 的 agent loop,不会自己产生 tool_execution_* 事件 —— 这里手动
				// 补一对,前后各发一次,失败路径(catch 分支)也要发,否则一次失败的探针会在
				// pi 侧凭空消失、A6 又对不上。
				options.emitPluginToolEvent?.({ type: "tool_execution_start", toolName: name });
				let result: Awaited<ReturnType<typeof tool.execute>>;
				try {
					result = await tool.execute("plugin", args as never, undefined, undefined, {} as never);
				} catch (error) {
					options.emitPluginToolEvent?.({ type: "tool_execution_end", toolName: name, isError: true });
					throw error;
				}
				options.emitPluginToolEvent?.({ type: "tool_execution_end", toolName: name, isError: false });
				const text = extractText(result.content);
				try {
					return JSON.parse(text);
				} catch {
					// 工具返回非 JSON 时把原文交回去 —— 由插件决定怎么理解,不在这层猜。
					return text;
				}
			},
		};
		const extensionFactories = instantiatePlugins(pluginEntries, pluginContext);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			// 剥光通用能力(照抄 packages/evals/src/pi-harness.ts)
			noExtensions: true, // 只过滤磁盘扫描,不影响 extensionFactories
			// noSkills 只过滤磁盘扫描,不挡下面的 additionalSkillPaths(resource-loader.ts:467-469)。
			// 两者并存是刻意的:底座剥光通用能力,任务需要的能力由 spec 自己声明。
			noSkills: true,
			additionalSkillPaths: options.skillPaths,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true, // 安全项:阻止 AGENTS.md / CLAUDE.md 被加载(prompt injection 直通车)
			systemPrompt: spec.systemPrompt,
			// 与 systemPrompt 同一条通路(DefaultResourceLoaderOptions.appendSystemPrompt,
			// resource-loader.ts):每项要么是字面文本,要么是存在的文件路径。留空(undefined)
			// 时 pi 退回磁盘发现 APPEND_SYSTEM.md —— 那两个候选路径都在本任务独占的
			// cwd/agentDir 下,不会读到宿主的共享状态。
			appendSystemPrompt: spec.appendSystemPrompt,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			thinkingLevel: spec.thinkingLevel ?? "off",
			noTools: "all",
			customTools: tools,
			tools: spec.tools, // 必填 —— 省略等于工具全关
			excludeTools: spec.excludeTools,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		return {
			session,
			specId: spec.id,
			resources: resourceLoader,
			callTool: pluginContext.callTool,
			dispose: async () => {
				session.dispose();
				await disposeToolset();
			},
		};
	} catch (error) {
		// createAgentSession (or anything above it in this block) threw before the caller
		// ever got an Assembled.dispose() to call -- release the toolset handle ourselves
		// so a mid-assembly failure can't leak it (e.g. an MCP child process).
		try {
			await disposeToolset();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Assembly failed and toolset disposal also failed");
		}
		throw error;
	}
}

async function resolveModel(spec: RuntimeSpec, profile: ProviderProfile, agentDir: string) {
	const binding = resolveRole(profile, spec.model.role);
	const apiKey = requireApiKey(profile);
	// CreateModelRuntimeOptions.authPath is `string | undefined` (unlike modelsPath,
	// it has no `null` variant). Leaving it unset would fall back to the operator's
	// real ~/.pi/agent/auth.json (AuthStorage creates that file on first use) --
	// this task-runtime never reads stored credentials (auth always comes from
	// ProviderProfile.apiKeyEnv via requireApiKey above), so scope the store inside
	// this task's own agentDir instead of touching shared host state.
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(agentDir, "auth.json") });
	modelRuntime.registerProvider(binding.provider, {
		baseUrl: profile.baseUrl,
		apiKey,
		api: profile.api,
		models: [
			{
				id: binding.modelId,
				name: binding.modelId,
				// reasoning/cost come from RoleBinding, not a hardcoded default: pi's
				// getSupportedThinkingLevels() collapses to ["off"] when reasoning is false
				// (silently clamping RuntimeSpec.thinkingLevel), and session cost stats stay
				// at 0 when cost is 0 (silently defeating RuntimeLimits.maxCostUsd). Both are
				// environment facts the ProviderProfile author must declare explicitly.
				reasoning: binding.reasoning,
				// 本层暂不支持多模态角色绑定,也没有对应的 RuntimeSpec 字段声明这项能力,
				// 所以留作固定默认值(不是 review 要求整改的范围)。
				input: ["text"],
				cost: binding.cost,
				contextWindow: binding.contextWindow,
				maxTokens: binding.maxTokens,
			},
		],
	});
	const model = modelRuntime.getModel(binding.provider, binding.modelId);
	if (!model) {
		throw new Error(
			`Model ${binding.provider}/${binding.modelId} not found after registering ProviderProfile "${profile.id}"`,
		);
	}
	return { modelRuntime, model };
}
