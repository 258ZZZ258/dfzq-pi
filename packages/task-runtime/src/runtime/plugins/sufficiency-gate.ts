import type { FinalJudge, JudgeContext, JudgeVerdict } from "../final-judge.ts";
import { extractJsonBlock } from "../output-contract.ts";
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
 *
 * 第一个参数是 `basis[]` 引用的 clause_id(见 `extractBasisClauseIds`),不是本 run
 * 检索到过的全部 clause_id。
 */
export type AssessFn = (citedClauseIds: readonly string[], matters: readonly string[]) => Promise<SufficiencyReport>;

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
 * `unfetched` 的语义没变(检索到了却没取正文的那些);但有判定力的只是它与
 * `basis` 引用的交集 ——「被引用了、却没取过正文就下结论」才是这个判官要拦的事,
 * 检索到了却没打算引用的,不算。
 */
interface AssessToolResult {
	hit_count_sufficient?: boolean;
	unfetched?: string[];
	retrieved_count?: number;
	fetched_count?: number;
}

/**
 * 从最终助手文本里取 `basis[].clause_id`。
 *
 * C3 判据收窄靠它:旧判据是 `unfetched.length === 0`,要求把**检索到过的每一条**都取完正文
 * —— `search_policy` 每次回 8 条、`enumerate_clauses` 回最多 50 条,实测不可满足
 * (规格 §1.4:真 run `5a29d7bf` 连判两次不通过,最后靠 onExhausted:"pass" 放行,白花 42.3s)。
 *
 * 收窄后判的是「**被引用了、却没取过正文**」—— 那才是 system.md:12 那条纪律要拦的事
 * (凭条款标题猜内容)。
 *
 * 解析不出 JSON / 没有 basis ⇒ 回 `[]` ⇒ 交集必空 ⇒ C3 放行。**这是有意的**:
 * 那种输出的病是「不合契约」,在 C6 挂载时(spec 声明了 `outputContract`)归它判,
 * 不该由 C3 用一个语义不对的理由拦下来。
 */
export function extractBasisClauseIds(assistantText: string): string[] {
	const extracted = extractJsonBlock(assistantText);
	if (extracted.kind !== "ok") return [];
	const basis = (extracted.value as { basis?: unknown }).basis;
	if (!Array.isArray(basis)) return [];
	return basis
		.map((item) =>
			typeof item === "object" && item !== null ? (item as { clause_id?: unknown }).clause_id : undefined,
		)
		.filter((id): id is string => typeof id === "string");
}

/** 缺省实现:走 per-run 的 MCP 会话调 C1。注入版保留作测试缝。 */
function assessViaTool(ctx: PluginContext): AssessFn {
	return async (citedClauseIds, matters) => {
		const raw = (await ctx.callTool("assess_sufficiency", { matters: [...matters] })) as AssessToolResult;
		const unfetched = Array.isArray(raw?.unfetched) ? raw.unfetched : [];
		// 收窄:只留「被 basis 引用了、却在 unfetched 里」的那些。跨仓零改动 ——
		// C1 的 assess_sufficiency 返回体不变,交集在本层求。
		const cited = new Set(citedClauseIds);
		const missing = unfetched.filter((id) => cited.has(id));
		return { sufficient: missing.length === 0, covered: [], missing };
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
					const report = await runAssess(extractBasisClauseIds(context.lastAssistantText), matters);
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
