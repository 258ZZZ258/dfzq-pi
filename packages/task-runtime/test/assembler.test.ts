import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { assemble } from "../src/runtime/assembler.ts";
import { PluginRegistry } from "../src/runtime/plugin-registry.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

function spec(overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
	return {
		id: "demo",
		model: { role: "main" },
		toolset: "demo",
		tools: ["echo"],
		limits: { maxTurns: 5 },
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

function echoTool() {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo the input back.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id: string, params: { text: string }) => ({
			output: params.text,
			content: params.text,
		}),
	} as never;
}

function toolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [echoTool()]);
	return registry;
}

/** A "demo" toolset whose handle carries a caller-supplied dispose spy, so tests can
 *  observe whether/when it gets released. */
function toolsetsWithDispose(dispose: () => Promise<void>): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => ({ tools: [echoTool()], dispose }));
	return registry;
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

describe("assemble", () => {
	it("builds a session with only the whitelisted tool active", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			spec: spec(),
			profile,
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		expect(assembled.session.getActiveToolNames()).toEqual(["echo"]);
	});

	it("runs a prompt end to end against the faux provider", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([fauxAssistantMessage("hello from faux")]);
		const assembled = await assemble({
			spec: spec(),
			profile,
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		await assembled.session.prompt("hi");
		expect(assembled.session.getLastAssistantText()).toContain("hello from faux");
	});

	it("fails at assembly time when the toolset is unknown", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				spec: spec({ toolset: "missing" }),
				profile,
				registry: new PluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/toolset "missing"/);
	});
});

describe("assemble - tool whitelist cross-validation", () => {
	// pi's setActiveToolsByName silently drops unknown tool names instead of throwing
	// (agent-session.ts), so a typo in spec.tools/spec.excludeTools would otherwise
	// shrink or no-op silently. The assembler cross-validates against the toolset's
	// actual tool names once it has resolved them.
	it("fails at assembly time when spec.tools references a tool the toolset does not provide", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				spec: spec({ tools: ["echo", "typo"] }),
				profile,
				registry: new PluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/tools whitelist references unknown tool\(s\) "typo"/);
	});

	it("fails at assembly time when spec.excludeTools references a tool the toolset does not provide", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				spec: spec({ excludeTools: ["typo"] }),
				profile,
				registry: new PluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/excludeTools references unknown tool\(s\) "typo"/);
	});
});

describe("assemble - resolveModel (no modelOverride)", () => {
	// The other tests all bypass resolveModel() via modelOverride; these exercise the
	// real ProviderProfile -> ModelRuntime.registerProvider() -> getModel() path.
	it("registers the ProviderProfile binding into ModelRuntime and resolves a model", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const envVar = "DFZQ_ASSEMBLER_RESOLVE_KEY";
		process.env[envVar] = "test-key";
		cleanups.push(async () => {
			delete process.env[envVar];
		});
		const realProfile: ProviderProfile = {
			id: "resolve-model-coverage",
			baseUrl: "http://localhost:0/v1",
			apiKeyEnv: envVar,
			api: "openai-completions",
			roles: {
				main: {
					provider: "resolve-model-coverage-provider",
					modelId: "m1",
					contextWindow: 8192,
					maxTokens: 1024,
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			},
		};
		const assembled = await assemble({
			spec: spec(),
			profile: realProfile,
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			// No modelOverride here on purpose.
		});
		cleanups.push(assembled.dispose);
		expect(assembled.session.getActiveToolNames()).toEqual(["echo"]);
	});

	it("throws a descriptive error when the registered model cannot be found afterward", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const envVar = "DFZQ_ASSEMBLER_RESOLVE_MISSING_KEY";
		process.env[envVar] = "test-key";
		cleanups.push(async () => {
			delete process.env[envVar];
		});
		// resolveModel() always registers the exact (provider, modelId) pair it then
		// looks up, so under type-safe RoleBinding input getModel() can never actually
		// miss -- there is no legitimate way to construct that failure through the
		// public API. Spy on ModelRuntime.prototype.getModel to force the branch
		// directly and pin its error message instead of leaving it uncovered.
		const getModelSpy = vi.spyOn(ModelRuntime.prototype, "getModel").mockReturnValue(undefined);
		cleanups.push(async () => {
			getModelSpy.mockRestore();
		});
		const missingProfile: ProviderProfile = {
			id: "resolve-model-missing",
			baseUrl: "http://localhost:0/v1",
			apiKeyEnv: envVar,
			api: "openai-completions",
			roles: {
				main: {
					provider: "missing-provider",
					modelId: "missing-model",
					contextWindow: 8192,
					maxTokens: 1024,
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			},
		};
		await expect(
			assemble({
				spec: spec(),
				profile: missingProfile,
				registry: new PluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
			}),
		).rejects.toThrow(
			/Model missing-provider\/missing-model not found after registering ProviderProfile "resolve-model-missing"/,
		);
	});
});

describe("assemble - toolset handle ownership", () => {
	// ToolsetRegistry.resolve() handles are per-call, not per-registry (see
	// src/toolsets/registry.ts): two Assembled built from the same registry must be
	// able to dispose independently without tearing down each other's resources.
	it("lets two Assembled built from the same registry dispose independently", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const disposeFirst = vi.fn(async () => {});
		const disposeSecond = vi.fn(async () => {});
		let calls = 0;
		const sharedToolsets = new ToolsetRegistry();
		sharedToolsets.register("demo", async () => {
			calls += 1;
			return { tools: [echoTool()], dispose: calls === 1 ? disposeFirst : disposeSecond };
		});

		const first = await assemble({
			spec: spec(),
			profile,
			registry: new PluginRegistry(),
			toolsets: sharedToolsets,
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		const second = await assemble({
			spec: spec(),
			profile,
			registry: new PluginRegistry(),
			toolsets: sharedToolsets,
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});

		await first.dispose();
		expect(disposeFirst).toHaveBeenCalledTimes(1);
		expect(disposeSecond).not.toHaveBeenCalled();

		await second.dispose();
		expect(disposeSecond).toHaveBeenCalledTimes(1);
		expect(disposeFirst).toHaveBeenCalledTimes(1); // still just once, not re-triggered by second's dispose
	});

	// If something after toolsets.resolve() throws (a plugin hook conflict here), the
	// caller never gets an Assembled.dispose() to release the toolset handle with --
	// assemble() must release it itself instead of leaking it.
	it("releases the toolset handle when assembly fails after tools are resolved", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const disposeSpy = vi.fn(async () => {});
		const conflictingPlugins = new PluginRegistry();
		conflictingPlugins.register({ name: "a", hooks: ["tool_result"], factory: () => ({}) as never });
		conflictingPlugins.register({ name: "b", hooks: ["tool_result"], factory: () => ({}) as never });

		await expect(
			assemble({
				spec: spec({ extraPlugins: ["a", "b"] }),
				profile,
				registry: conflictingPlugins,
				toolsets: toolsetsWithDispose(disposeSpy),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/replacing hook "tool_result"/);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});
