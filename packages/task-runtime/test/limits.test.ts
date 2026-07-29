import { describe, expect, it, vi } from "vitest";
import { createLimitsDescriptor, type LimitState } from "../src/runtime/plugins/limits.ts";

interface CapturedHandlers {
	turn_end?: (event: unknown) => Promise<unknown>;
}

/** 用一个假 ExtensionAPI 捕获插件注册的 handler,不起真会话。 */
function instantiate(state: LimitState, hooks: Parameters<typeof createLimitsDescriptor>[1]) {
	const captured: CapturedHandlers = {};
	const descriptor = createLimitsDescriptor(state, hooks);
	const extension = descriptor.factory();
	const api = {
		on: (type: keyof CapturedHandlers, handler: (event: unknown) => Promise<unknown>) => {
			captured[type] = handler;
		},
	};
	const factory = typeof extension === "function" ? extension : extension.factory;
	factory(api as never);
	return captured;
}

const zeroStats = () => ({ totalTokens: 0, cost: 0 });

describe("limits plugin", () => {
	it("declares only observing hooks", () => {
		const descriptor = createLimitsDescriptor({ turns: 0 }, { limits: {}, getStats: zeroStats, abort: () => {} });
		expect(descriptor.hooks).toEqual(["turn_end"]);
	});

	it("aborts when maxTurns is exceeded", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		const handlers = instantiate(state, { limits: { maxTurns: 2 }, getStats: zeroStats, abort });
		await handlers.turn_end?.({});
		expect(abort).not.toHaveBeenCalled();
		await handlers.turn_end?.({});
		expect(abort).toHaveBeenCalledTimes(1);
		expect(state.tripped).toBe("maxTurns");
		expect(state.turns).toBe(2);
	});

	it("aborts when maxTotalTokens is exceeded", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		const handlers = instantiate(state, {
			limits: { maxTotalTokens: 100 },
			getStats: () => ({ totalTokens: 101, cost: 0 }),
			abort,
		});
		await handlers.turn_end?.({});
		expect(state.tripped).toBe("maxTotalTokens");
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("aborts when maxCostUsd is exceeded", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		const handlers = instantiate(state, {
			limits: { maxCostUsd: 1 },
			getStats: () => ({ totalTokens: 0, cost: 1.5 }),
			abort,
		});
		await handlers.turn_end?.({});
		expect(state.tripped).toBe("maxCostUsd");
	});

	it("aborts only once even if more turns arrive", async () => {
		const state: LimitState = { turns: 0 };
		const abort = vi.fn();
		const handlers = instantiate(state, { limits: { maxTurns: 1 }, getStats: zeroStats, abort });
		await handlers.turn_end?.({});
		await handlers.turn_end?.({});
		expect(abort).toHaveBeenCalledTimes(1);
	});
});
