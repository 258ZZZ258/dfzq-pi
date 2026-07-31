import { describe, expect, it } from "vitest";
import { type PluginContext, PluginRegistry } from "../src/runtime/plugin-registry.ts";

/** 大多数用例不关心 per-run 上下文,给个够用的最小占位。 */
function makeContext(): PluginContext {
	return {
		getRunId: () => "r1",
		getSession: () => {
			throw new Error("not assembled yet");
		},
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: () => {},
		getRunInput: () => "",
		callTool: async () => ({}),
	};
}

function makeRegistry(): PluginRegistry {
	const registry = new PluginRegistry();
	registry.register({
		name: "budget",
		hooks: ["tool_result"],
		factory: () => ({ name: "budget", factory: () => {} }),
	});
	registry.register({
		name: "shaper",
		hooks: ["tool_result"],
		factory: () => ({ name: "shaper", factory: () => {} }),
	});
	registry.register({
		name: "counter",
		hooks: ["turn_end"],
		factory: () => ({ name: "counter", factory: () => {} }),
	});
	registry.register({
		name: "timer",
		hooks: ["turn_end"],
		factory: () => ({ name: "timer", factory: () => {} }),
	});
	return registry;
}

describe("PluginRegistry", () => {
	it("resolves registered plugins in order", () => {
		const out = makeRegistry().resolveAll(["counter", "timer"], makeContext());
		expect(out.map((e) => (typeof e === "function" ? "fn" : e.name))).toEqual(["counter", "timer"]);
	});

	it("throws on an unregistered name", () => {
		expect(() => makeRegistry().resolveAll(["ghost"], makeContext())).toThrow(/plugin "ghost" is not registered/);
	});

	it("allows stacking observing hooks", () => {
		expect(() => makeRegistry().resolveAll(["counter", "timer"], makeContext())).not.toThrow();
	});

	it("rejects two plugins on the same replacing hook", () => {
		expect(() => makeRegistry().resolveAll(["budget", "shaper"], makeContext())).toThrow(
			/replacing hook "tool_result".*budget.*shaper/s,
		);
	});

	// 复审 M-4:同一个插件名字被声明两次(比如 spec 的 stopPolicy 与 extraPlugins 都写了同一个
	// 名字)此前完全不受拦 —— 替换型 hook 校验只看 hooks 数组,counter 只挂观察型的 turn_end,
	// 两次声明对它来说"看起来"毫无冲突。但 lookupAll 会把它解析成两个独立的 PluginEntry,
	// instantiatePlugins 会把同一个 factory 调用两次:对 sufficiency-gate 这类往
	// PluginContext.registerFinalJudge 里塞状态的插件,后果是 judges 数组里出现两个同名判官、
	// assess() 调用与探测轮次悄悄翻倍。这里单独用 counter(纯观察型 hook)证明"重名本身"就该被拒,
	// 不依赖也不会与替换型 hook 冲突校验混在一起。
	it("rejects the same plugin name declared twice, even when its only hook is an observing one", () => {
		expect(() => makeRegistry().resolveAll(["counter", "counter"], makeContext())).toThrow(
			/plugin "counter" is declared more than once/,
		);
	});

	it("passes options through to the factory", () => {
		const registry = new PluginRegistry();
		let seen: unknown;
		registry.register({
			name: "opt",
			hooks: [],
			factory: (_ctx, options) => {
				seen = options;
				return { name: "opt", factory: () => {} };
			},
		});
		registry.resolveAll([{ name: "opt", options: { a: 1 } }], makeContext());
		expect(seen).toEqual({ a: 1 });
	});

	it("hands the per-run context to every plugin factory", () => {
		const seen: PluginContext[] = [];
		const registry = new PluginRegistry();
		registry.register({
			name: "probe",
			hooks: [],
			factory: (ctx) => {
				seen.push(ctx);
				return { name: "probe", factory: () => {} };
			},
		});
		const ctx: PluginContext = {
			getRunId: () => "r1",
			getSession: () => {
				throw new Error("not assembled yet");
			},
			abort: () => {},
			limitState: { turns: 0 },
			registerFinalJudge: () => {},
			getRunInput: () => "",
			callTool: async () => ({}),
		};
		registry.resolveAll(["probe"], ctx);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.getRunId()).toBe("r1");
	});

	it("keeps getSession lazy so a factory may run before assemble() returns", () => {
		let session: { id: string } | undefined;
		const registry = new PluginRegistry();
		let captured: (() => unknown) | undefined;
		registry.register({
			name: "late",
			hooks: [],
			factory: (ctx) => {
				// 工厂**运行时**不碰 session —— 只把惰性句柄存下来
				captured = ctx.getSession;
				return { name: "late", factory: () => {} };
			},
		});
		const ctx: PluginContext = {
			getRunId: () => "r1",
			getSession: () => session as never,
			abort: () => {},
			limitState: { turns: 0 },
			registerFinalJudge: () => {},
			getRunInput: () => "",
			callTool: async () => ({}),
		};
		registry.resolveAll(["late"], ctx);
		session = { id: "assembled-later" };
		expect((captured?.() as { id: string }).id).toBe("assembled-later");
	});
});
