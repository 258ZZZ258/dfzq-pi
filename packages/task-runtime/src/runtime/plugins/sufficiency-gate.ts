import type { FinalJudge, JudgeContext, JudgeVerdict } from "../final-judge.ts";
import type { PluginContext, PluginDescriptor } from "../plugin-registry.ts";

export const SUFFICIENCY_GATE_PLUGIN_NAME = "sufficiency-gate";

export interface SufficiencyReport {
	sufficient: boolean;
	covered: string[];
	missing: string[];
}

/**
 * C1 的 assess_sufficiency 工具的 TS 侧签名。**由注册方注入**,插件不感知 MCP ——
 * 这样插件可以单测,C1 上线后也只需在 createDefaultPluginRegistry 的调用处接一根线。
 */
export type AssessFn = (clauseIds: readonly string[], matters: readonly string[]) => Promise<SufficiencyReport>;

export interface SufficiencyGateOptions {
	maxProbes?: number;
	matters?: string[] | "auto";
}

/** matters:"auto" 的兜底抽取:按中文标点与换行切分,去掉过短的片段。 */
export function extractMatters(input: string): string[] {
	return input
		.split(/[。;;\n]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 4);
}

export function createSufficiencyGateDescriptor(assess: AssessFn): PluginDescriptor {
	return {
		name: SUFFICIENCY_GATE_PLUGIN_NAME,
		// 不挂任何 hook:它参与的是终局判定,那个时点 hook 看不见(hook 只看得见单轮)。
		hooks: [],
		factory: (ctx: PluginContext, rawOptions?: Record<string, unknown>) => {
			const options = (rawOptions ?? {}) as SufficiencyGateOptions;
			const judge: FinalJudge = {
				name: SUFFICIENCY_GATE_PLUGIN_NAME,
				maxAttempts: options.maxProbes ?? 2,
				// 证据始终不足不是错误 —— 让模型用 confidence:"low" + gaps 如实交代,
				// 比把整个 run 判成 error 更有用。
				onExhausted: "pass",
				judge: async (context: JudgeContext): Promise<JudgeVerdict> => {
					const matters =
						options.matters === undefined || options.matters === "auto"
							? extractMatters(ctx.getRunInput())
							: options.matters;
					const report = await assess(context.clauseIds, matters);
					if (report.sufficient) return { ok: true };
					return {
						ok: false,
						detail: `证据不足,缺失:${report.missing.join("、")}`,
						followUp:
							`证据不足。已覆盖:${report.covered.join("、")};缺失:${report.missing.join("、")}。` +
							`请针对缺失项继续查证,补齐后再给结论。`,
					};
				},
			};
			ctx.registerFinalJudge(judge);
			return { name: SUFFICIENCY_GATE_PLUGIN_NAME, factory: () => {} };
		},
	};
}
