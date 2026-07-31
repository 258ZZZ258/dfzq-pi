import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeLimits } from "../../spec/types.ts";
import type { LimitKind, LimitState } from "../contract.ts";
import type { PluginContext, PluginDescriptor } from "../plugin-registry.ts";

export const LIMITS_PLUGIN_NAME = "limits";

/** assembler 构造的 options 形状。不来自 spec JSON 的插件声明,来自 spec.limits 字段。 */
export interface LimitsOptions {
	limits: RuntimeLimits;
}

/**
 * pi 的 shouldStopAfterTurn 在 Agent 层就断了(agent.ts 零引用),AgentSession 够不着。
 * 所以限额只能数 turn_end + abort()。runTimeoutMs 由 SessionRuntime 用 setTimeout 挂,
 * 写同一个 LimitState。
 *
 * 进程级描述符:per-run 状态全部从 ctx 取,所以同一个 PluginRegistry 可以被反复复用。
 */
export const limitsDescriptor: PluginDescriptor = {
	name: LIMITS_PLUGIN_NAME,
	hooks: ["turn_end"], // 观察型,可与 stopPolicy 叠加
	factory: (ctx: PluginContext, options?: Record<string, unknown>) => {
		// 缺 options 只有一个来源:有人绕开 assembler 的 `{ limits: spec.limits }` 直接挂了
		// 这个描述符(spec.limits 在 RuntimeSpec 上必填,validateSpec 还要求至少一项)。
		// 过去这里是 `?? {}` —— 一个永不 abort 却照常计数的空限额计数器,正是把重复挂载
		// 变静默的直接原因。让它响起来。
		const limits = (options as Partial<LimitsOptions> | undefined)?.limits;
		if (limits === undefined) {
			throw new Error(
				`plugin "${LIMITS_PLUGIN_NAME}" was instantiated without its LimitsOptions.limits; ` +
					`it is mounted by assemble() from spec.limits and must not be declared as a plugin ref`,
			);
		}
		const state = ctx.limitState;
		return {
			name: LIMITS_PLUGIN_NAME,
			factory: (pi: ExtensionAPI) => {
				pi.on("turn_end", async () => {
					if (state.tripped) return; // 已触发过,不重复 abort
					state.turns += 1;
					const tripped = evaluate(state, limits, ctx);
					if (!tripped) return;
					state.tripped = tripped;
					ctx.abort();
				});
			},
		};
	},
};

function evaluate(state: LimitState, limits: RuntimeLimits, ctx: PluginContext): LimitKind | undefined {
	if (limits.maxTurns !== undefined && state.turns >= limits.maxTurns) return "maxTurns";
	const stats = ctx.getSession().getSessionStats();
	if (limits.maxTotalTokens !== undefined && stats.tokens.total > limits.maxTotalTokens) return "maxTotalTokens";
	if (limits.maxCostUsd !== undefined && stats.cost > limits.maxCostUsd) return "maxCostUsd";
	return undefined;
}
