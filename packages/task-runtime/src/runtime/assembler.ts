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

export interface AssembleOptions {
	spec: RuntimeSpec;
	profile: ProviderProfile;
	registry: PluginRegistry;
	toolsets: ToolsetRegistry;
	cwd: string;
	agentDir: string;
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
}

export interface Assembled {
	session: AgentSession;
	specId: string;
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
					throw new Error(
						`Plugin requested tool "${name}", which this run's toolset does not provide ` +
							`(available: ${formatNames([...byName.keys()])})`,
					);
				}
				const result = await tool.execute("plugin", args as never, undefined, undefined, {} as never);
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
			noSkills: true,
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
