import { describe, expect, it, vi } from "vitest";
import type { LimitState } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { limitsDescriptor } from "../src/runtime/plugins/limits.ts";

/** 用假 ExtensionAPI 捕获插件注册的 handler,不起真会话。 */
function instantiate(
	limits: Record<string, number>,
	state: LimitState,
	stats: { totalTokens: number; cost: number },
	abort: () => void,
) {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	const ctx: PluginContext = {
		specId: "s1",
		getRunId: () => "r1",
		getSession: () =>
			({ getSessionStats: () => ({ tokens: { total: stats.totalTokens }, cost: stats.cost }) }) as never,
		abort,
		limitState: state,
	};
	const extension = limitsDescriptor.factory(ctx, { limits });
	const factory = typeof extension === "function" ? extension : extension.factory;
	(factory as (api: unknown) => void)({
		on: (_type: string, h: (event: unknown) => Promise<unknown>) => {
			handler = h;
		},
	});
	return () => handler?.({}) ?? Promise.resolve(undefined);
}

const zero = { totalTokens: 0, cost: 0 };

describe("limits plugin", () => {
	it("declares only observing hooks", () => {
		expect(limitsDescriptor.hooks).toEqual(["turn_end"]);
	});

	it("is registered in the default plugin registry", () => {
		expect(createDefaultPluginRegistry().has("limits")).toBe(true);
	});

	it("aborts when maxTurns is exceeded", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		const turnEnd = instantiate({ maxTurns: 2 }, state, zero, abort);
		await turnEnd();
		expect(abort).not.toHaveBeenCalled();
		await turnEnd();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(state.tripped).toBe("maxTurns");
		expect(state.turns).toBe(2);
	});

	it("aborts when maxTotalTokens is exceeded", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		await instantiate({ maxTotalTokens: 100 }, state, { totalTokens: 101, cost: 0 }, abort)();
		expect(state.tripped).toBe("maxTotalTokens");
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("aborts when maxCostUsd is exceeded", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		await instantiate({ maxCostUsd: 1 }, state, { totalTokens: 0, cost: 1.5 }, abort)();
		expect(state.tripped).toBe("maxCostUsd");
	});

	it("aborts only once even if more turns arrive", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		const turnEnd = instantiate({ maxTurns: 1 }, state, zero, abort);
		await turnEnd();
		await turnEnd();
		expect(abort).toHaveBeenCalledTimes(1);
	});
});
