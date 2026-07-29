import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/runtime/plugin-registry.ts";

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
		const out = makeRegistry().resolveAll(["counter", "timer"]);
		expect(out.map((e) => (typeof e === "function" ? "fn" : e.name))).toEqual(["counter", "timer"]);
	});

	it("throws on an unregistered name", () => {
		expect(() => makeRegistry().resolveAll(["ghost"])).toThrow(/plugin "ghost" is not registered/);
	});

	it("allows stacking observing hooks", () => {
		expect(() => makeRegistry().resolveAll(["counter", "timer"])).not.toThrow();
	});

	it("rejects two plugins on the same replacing hook", () => {
		expect(() => makeRegistry().resolveAll(["budget", "shaper"])).toThrow(
			/replacing hook "tool_result".*budget.*shaper/s,
		);
	});

	it("passes options through to the factory", () => {
		const registry = new PluginRegistry();
		let seen: unknown;
		registry.register({
			name: "opt",
			hooks: [],
			factory: (options) => {
				seen = options;
				return { name: "opt", factory: () => {} };
			},
		});
		registry.resolveAll([{ name: "opt", options: { a: 1 } }]);
		expect(seen).toEqual({ a: 1 });
	});
});
