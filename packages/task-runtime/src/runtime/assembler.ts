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
import type { PluginRegistry } from "./plugin-registry.ts";

export interface AssembleOptions {
	spec: RuntimeSpec;
	profile: ProviderProfile;
	registry: PluginRegistry;
	toolsets: ToolsetRegistry;
	cwd: string;
	agentDir: string;
	/** 本层注入的内置插件(limits / observability),先于 spec 声明的插件注册 */
	builtinPlugins?: PluginRef[];
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

	const tools = await toolsets.resolve(spec.toolset);

	const pluginRefs: PluginRef[] = [
		...(options.builtinPlugins ?? []),
		...(spec.contextStrategy ? [spec.contextStrategy] : []),
		...(spec.stopPolicy ? [spec.stopPolicy] : []),
		...(spec.resultPolicy ? [spec.resultPolicy] : []),
		...(spec.approvalPolicy ? [spec.approvalPolicy] : []),
		...(spec.extraPlugins ?? []),
	];
	const extensionFactories = registry.resolveAll(pluginRefs);

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
			await toolsets.disposeAll();
		},
	};
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
				// ProviderProfile/RoleBinding 不携带这三项(pi 探测不了自建网关的元数据),
				// 用保守的静态默认值填充,而不是断言掉类型检查:
				// - reasoning: false —— 没有信息证明该模型支持扩展推理,保守关闭
				// - input: ["text"] —— 本层暂不支持多模态角色绑定
				// - cost: 全 0 —— 内网 vLLM/自建网关通常不计费,真实计费应在 ProviderProfile 里补建字段再传入
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
