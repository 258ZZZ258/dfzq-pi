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

/**
 * C1 的 `assess_sufficiency` 返回的取证完整性报告。
 *
 * ⚠ 字段名跟着 C1 走:那边刻意叫 `hit_count_sufficient` 而不是 `sufficient` ——
 * 底层 `assess()` 只做 `len(candidates) >= min_hits` 的计数,**不做语义判定**。
 * 真正有判定力的是 `unfetched`:检索到了却没取正文就下结论,是这个判官要拦的事。
 */
interface AssessToolResult {
	hit_count_sufficient?: boolean;
	unfetched?: string[];
	retrieved_count?: number;
	fetched_count?: number;
}

/** 缺省实现:走 per-run 的 MCP 会话调 C1。注入版保留作测试缝。 */
function assessViaTool(ctx: PluginContext): AssessFn {
	return async (_clauseIds, matters) => {
		const raw = (await ctx.callTool("assess_sufficiency", { matters: [...matters] })) as AssessToolResult;
		const fetchedCount = typeof raw?.fetched_count === "number" ? raw.fetched_count : 0;
		const hitCountSufficient = raw?.hit_count_sufficient === true;
		return {
			// 已取到至少一条正文且检索命中达标，就允许模型基于实际引用收束。不能要求把
			// 每轮宽召回的所有候选都逐一回查：后续检索会持续扩张 unfetched，终局判官会
			// 反复 reprompt 而永不结束。C6 仍会校验最终 basis 的每个 clause_id 都来自检索。
			sufficient: hitCountSufficient && fetchedCount > 0,
			covered: [],
			missing: Array.isArray(raw?.unfetched) && fetchedCount === 0 ? raw.unfetched : [],
		};
	};
}

export function createSufficiencyGateDescriptor(assess?: AssessFn): PluginDescriptor {
	return {
		name: SUFFICIENCY_GATE_PLUGIN_NAME,
		// 不挂任何 hook:它参与的是终局判定,那个时点 hook 看不见(hook 只看得见单轮)。
		hooks: [],
		factory: (ctx: PluginContext, rawOptions?: Record<string, unknown>) => {
			const options = (rawOptions ?? {}) as SufficiencyGateOptions;
			// 注入优先(测试缝),否则走 per-run 的 MCP 会话。**注册不再依赖调用方传线** ——
			// 此前 deps.assess 缺省就不注册,而两个生产调用点都不传 ⇒ C3 永不可达。
			const runAssess = assess ?? assessViaTool(ctx);
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
					const report = await runAssess(context.clauseIds, matters);
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
