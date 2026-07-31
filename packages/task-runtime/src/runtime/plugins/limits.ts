import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeLimits } from "../../spec/types.ts";
import type { LimitKind, LimitState } from "../contract.ts";
import type { PluginDescriptor } from "../plugin-registry.ts";

export type { LimitState };

export interface LimitsHooks {
	limits: RuntimeLimits;
	getStats: () => { totalTokens: number; cost: number };
	abort: () => void;
}

export const LIMITS_PLUGIN_NAME = "limits";

/**
 * pi 的 shouldStopAfterTurn 在 Agent 层就断了(agent.ts 零引用),AgentSession 够不着。
 * 所以限额只能数 turn_end + abort()。runTimeoutMs 由 SessionRuntime 用 setTimeout 挂,
 * 写同一个 LimitState。
 */
export function createLimitsDescriptor(state: LimitState, hooks: LimitsHooks): PluginDescriptor {
	return {
		name: LIMITS_PLUGIN_NAME,
		hooks: ["turn_end"], // 观察型,可与 stopPolicy 叠加
		factory: (_ctx) => ({
			name: LIMITS_PLUGIN_NAME,
			factory: (pi: ExtensionAPI) => {
				pi.on("turn_end", async () => {
					if (state.tripped) return; // 已触发过,不重复 abort
					state.turns += 1;
					const tripped = evaluate(state, hooks);
					if (!tripped) return;
					state.tripped = tripped;
					hooks.abort();
				});
			},
		}),
	};
}

function evaluate(state: LimitState, hooks: LimitsHooks): LimitKind | undefined {
	const { limits } = hooks;
	if (limits.maxTurns !== undefined && state.turns >= limits.maxTurns) return "maxTurns";
	const stats = hooks.getStats();
	if (limits.maxTotalTokens !== undefined && stats.totalTokens > limits.maxTotalTokens) return "maxTotalTokens";
	if (limits.maxCostUsd !== undefined && stats.cost > limits.maxCostUsd) return "maxCostUsd";
	return undefined;
}
