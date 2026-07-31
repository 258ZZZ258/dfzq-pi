import { describe, expect, it, vi } from "vitest";
import type { LimitState } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
	return {
		specId: "s1",
		getRunId: () => "r1",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: () => {},
		getRunInput: () => "",
		...overrides,
	};
}

describe("createDefaultPluginRegistry", () => {
	it("registers limits", () => {
		expect(createDefaultPluginRegistry().has("limits")).toBe(true);
	});

	it("can be reused across assemblies without throwing already-registered", () => {
		const registry = createDefaultPluginRegistry();
		const first: LimitState = { turns: 0 };
		const second: LimitState = { turns: 0 };
		const refs = [{ name: "limits", options: { limits: { maxTurns: 1 } } }];
		expect(() => registry.resolveAll(refs, makeContext({ limitState: first }))).not.toThrow();
		expect(() => registry.resolveAll(refs, makeContext({ limitState: second }))).not.toThrow();
	});

	it("keeps per-run limit state separate between two instantiations", async () => {
		const registry = createDefaultPluginRegistry();
		const stateA: LimitState = { turns: 0 };
		const stateB: LimitState = { turns: 0 };
		const abortA = vi.fn();
		const abortB = vi.fn();
		const handlersA = captureTurnEnd(registry, stateA, abortA);
		captureTurnEnd(registry, stateB, abortB); // 只实例化、不驱动:B 的状态必须纹丝不动
		await handlersA();
		expect(stateA.turns).toBe(1);
		expect(stateB.turns).toBe(0);
		expect(abortA).toHaveBeenCalledTimes(1); // maxTurns:1
		expect(abortB).not.toHaveBeenCalled();
	});
});

/** 用假 ExtensionAPI 捕获 limits 注册的 turn_end handler。 */
function captureTurnEnd(
	registry: ReturnType<typeof createDefaultPluginRegistry>,
	limitState: LimitState,
	abort: () => void,
): () => Promise<unknown> {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	const [extension] = registry.resolveAll(
		[{ name: "limits", options: { limits: { maxTurns: 1 } } }],
		makeContext({ limitState, abort }),
	);
	const factory = typeof extension === "function" ? extension : extension?.factory;
	(factory as (api: unknown) => void)({
		on: (_type: string, h: (event: unknown) => Promise<unknown>) => {
			handler = h;
		},
	});
	return () => handler?.({}) ?? Promise.resolve(undefined);
}
