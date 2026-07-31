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
import type { PluginRef, RuntimeSpec } from "../spec/types.ts";
import { validateSpec } from "../spec/validate.ts";
import type { ToolsetRegistry } from "../toolsets/registry.ts";
import {
	instantiatePlugins,
	type PluginContext,
	type PluginDescriptor,
	type PluginEntry,
	type PluginRegistry,
} from "./plugin-registry.ts";

export interface AssembleOptions {
	spec: RuntimeSpec;
	profile: ProviderProfile;
	registry: PluginRegistry;
	toolsets: ToolsetRegistry;
	cwd: string;
	agentDir: string;
	/**
	 * 本层注入的 per-run 内置插件(limits / 将来的 observability),先于 spec 声明的插件挂载。
	 *
	 * 收的是 **PluginDescriptor 实例**而不是插件名:这些描述符的闭包捕获了本次 run 的状态
	 * (LimitState、本次 session 的 abort 句柄),按名字走 `registry` 就等于把 per-run 状态
	 * 写进进程级的 PluginRegistry —— 同一个 registry 第二次 assemble 会直接撞
	 * "already registered",并发两次则互相串状态。见 plugin-registry.ts 的类注释。
	 * 它们与 spec 声明的插件共用同一次替换型 hook 冲突校验(instantiatePlugins)。
	 */
	builtinPlugins?: readonly PluginDescriptor[];
	/** 本次装配的 per-run 上下文,透传给每个插件工厂。 */
	pluginContext: PluginContext;
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

		// spec 声明的插件是进程级的,照旧走 registry 解析;per-run 的内置插件由调用方直接
		// 给实例。两边拼成一张表后交给 instantiatePlugins() 做**一次**冲突校验,这样绕过
		// registry 的内置插件也照样受替换型 hook 保护。
		const specPluginRefs: PluginRef[] = [
			...(spec.contextStrategy ? [spec.contextStrategy] : []),
			...(spec.stopPolicy ? [spec.stopPolicy] : []),
			...(spec.resultPolicy ? [spec.resultPolicy] : []),
			...(spec.approvalPolicy ? [spec.approvalPolicy] : []),
			...(spec.extraPlugins ?? []),
		];
		const pluginEntries: PluginEntry[] = [
			...(options.builtinPlugins ?? []).map((descriptor) => ({ descriptor })),
			...registry.lookupAll(specPluginRefs),
		];
		const extensionFactories = instantiatePlugins(pluginEntries, options.pluginContext);

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
