/**
 * 环境级绑定。任务属性(RuntimeSpec)与环境属性(本文件)分离:
 * 同一份 spec 在内网 vLLM 与云端之间切换,只换 profile。
 */

export interface RoleBinding {
	/** 注册进 ModelRuntime 的 provider id */
	provider: string;
	modelId: string;
	/** pi 探测不了自建 provider 的元数据,必须手工填 */
	contextWindow: number;
	maxTokens: number;
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
