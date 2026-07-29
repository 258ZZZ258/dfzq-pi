/**
 * 环境级绑定。任务属性(RuntimeSpec)与环境属性(本文件)分离:
 * 同一份 spec 在内网 vLLM 与云端之间切换,只换 profile。
 */

/**
 * $/百万 token。镜像 pi-ai 的 ModelCost 形状(不含分档定价,本层暂不建模)。
 */
export interface RoleBindingCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RoleBinding {
	/** 注册进 ModelRuntime 的 provider id */
	provider: string;
	modelId: string;
	/** pi 探测不了自建 provider 的元数据,必须手工填 */
	contextWindow: number;
	maxTokens: number;
	/**
	 * 该模型是否支持扩展推理档位。pi 的 getSupportedThinkingLevels() 在 reasoning:false 时
	 * 只放行 "off"——不填/填错会让 RuntimeSpec.thinkingLevel 声明的档位被静默钳成 "off",
	 * 不抛错也不告警。必填,不给默认值:是否支持推理是环境事实,必须由 profile 作者显式声明,
	 * 不能由装配器替其决定。
	 */
	reasoning: boolean;
	/**
	 * 计费费率。RuntimeLimits.maxCostUsd 依赖它才能生效。必填,不给默认值:内网网关确实不计费,
	 * 就显式填全 0——那是 profile 作者的选择,不是装配器悄悄替其做的决定。
	 */
	cost: RoleBindingCost;
}

export interface ProviderProfile {
	id: string;
	baseUrl: string;
	/** 只存环境变量名,绝不存值 */
	apiKeyEnv: string;
	/** 内网 vLLM 与云端都走 OpenAI 风格网关,单一路径 */
	api: "openai-completions";
	roles: Record<string, RoleBinding>;
}

export function resolveRole(profile: ProviderProfile, role: string): RoleBinding {
	const binding = profile.roles[role];
	if (!binding) {
		const known = Object.keys(profile.roles).join(", ") || "(none)";
		throw new Error(`ProviderProfile "${profile.id}" has no binding for role "${role}". Bound roles: ${known}`);
	}
	return binding;
}

export function profileRoles(profile: ProviderProfile): Set<string> {
	return new Set(Object.keys(profile.roles));
}

export function requireApiKey(profile: ProviderProfile): string {
	const value = process.env[profile.apiKeyEnv];
	if (!value) {
		throw new Error(
			`Environment variable ${profile.apiKeyEnv} is not set (required by ProviderProfile "${profile.id}")`,
		);
	}
	return value;
}
