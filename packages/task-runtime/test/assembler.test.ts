import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { assemble } from "../src/runtime/assembler.ts";
import type { LimitState } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { type PluginContext, PluginRegistry } from "../src/runtime/plugin-registry.ts";
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

/** assemble() 的 per-run 上下文。本文件的用例不测限额,但 limits 现在是**无条件挂载**的
 *  (assembler.ts 从 registry lookup 出来),它的 turn_end 会真的读 getSession() —— 所以
 *  这里给的是一个能应答 getSessionStats() 的占位 session,不能是 throw。 */
function pluginContext(overrides: Partial<PluginContext> = {}): PluginContext {
	return {
		specId: "demo",
		getRunId: () => "r1",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
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
			pluginContext: pluginContext(),
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
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
			pluginContext: pluginContext(),
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		await assembled.session.prompt("hi");
		expect(assembled.session.getLastAssistantText()).toContain("hello from faux");
	});

	// Regression lock (final fix round, finding 2): RuntimeSpec.appendSystemPrompt was declared
	// in spec/types.ts and documented in the design doc, but assemble() never passed it to
	// DefaultResourceLoader -- a declared field that silently did nothing, which is the literal
	// counterexample to this layer's "assembly-time failures must be loud and early" rule.
	it("appends RuntimeSpec.appendSystemPrompt entries to the session system prompt", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			pluginContext: pluginContext(),
			spec: spec({ appendSystemPrompt: ["DFZQ-APPENDED-ONE", "DFZQ-APPENDED-TWO"] }),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);

		const systemPrompt = assembled.session.systemPrompt;
		expect(systemPrompt).toContain("You are a test agent."); // spec.systemPrompt still honored
		expect(systemPrompt).toContain("DFZQ-APPENDED-ONE");
		expect(systemPrompt).toContain("DFZQ-APPENDED-TWO");
	});

	it("leaves the system prompt free of appended text when appendSystemPrompt is omitted", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			pluginContext: pluginContext(),
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		expect(assembled.session.systemPrompt).not.toContain("DFZQ-APPENDED-ONE");
	});

	it("fails at assembly time when the toolset is unknown", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				pluginContext: pluginContext(),
				spec: spec({ toolset: "missing" }),
				profile,
				registry: createDefaultPluginRegistry(),
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
				pluginContext: pluginContext(),
				spec: spec({ tools: ["echo", "typo"] }),
				profile,
				registry: createDefaultPluginRegistry(),
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
				pluginContext: pluginContext(),
				spec: spec({ excludeTools: ["typo"] }),
				profile,
				registry: createDefaultPluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/excludeTools references unknown tool\(s\) "typo"/);
	});

	// Regression lock for fix round 2: these throws used to sit between
	// toolsets.resolve() and the try/catch that releases the toolset handle, so a
	// tools/excludeTools typo -- the exact case this validation exists to catch --
	// leaked whatever resolve() had opened (e.g. an MCP child process). The throw
	// must land inside the try so it goes through the same cleanup as every other
	// post-resolve() failure.
	it("still releases the toolset handle when spec.tools references an unknown tool", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const disposeSpy = vi.fn(async () => {});
		await expect(
			assemble({
				pluginContext: pluginContext(),
				spec: spec({ tools: ["echo", "typo"] }),
				profile,
				registry: createDefaultPluginRegistry(),
				toolsets: toolsetsWithDispose(disposeSpy),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/tools whitelist references unknown tool\(s\) "typo"/);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("still releases the toolset handle when spec.excludeTools references an unknown tool", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const disposeSpy = vi.fn(async () => {});
		await expect(
			assemble({
				pluginContext: pluginContext(),
				spec: spec({ excludeTools: ["typo"] }),
				profile,
				registry: createDefaultPluginRegistry(),
				toolsets: toolsetsWithDispose(disposeSpy),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/excludeTools references unknown tool\(s\) "typo"/);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});

describe("assemble - implicit limits plugin", () => {
	// 风险 12 的核心回归锁。limits 过去走 assemble({ builtinPlugins }) 的侧门,于是
	// PluginRegistry 在**所有**生产路径上都是空表,任何声明命名插件的 spec 装配即失败。
	// limits 现在由 assemble() 从 registry 无条件 lookup —— 空表必须**响亮地**失败,
	// 绝不能"registry 里没有就跳过"。那种兜底正是这次重构要消灭的静默失败本身。
	it("throws instead of silently skipping when the registry has no limits descriptor", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				pluginContext: pluginContext(),
				spec: spec(),
				profile,
				registry: new PluginRegistry(), // 裸表 = 误用;唯一合法来源是 createDefaultPluginRegistry()
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/plugin "limits" is not registered/);
	});

	// 接替原 `assemble - builtinPlugins` 的第 1 条(它锁的是"绕过 registry 的内置插件也照样
	// 受替换型 hook 保护")。builtinPlugins 删掉后已经没有"绕过"可言 —— 全部插件走同一张表、
	// 同一次校验。但替换型 hook 冲突校验本身仍要独立锁一条:下面 "toolset handle ownership"
	// 里那条同场景用例的主断言是 handle 释放,冲突只是它的触发手段,且不校验插件名。
	it("rejects a replacing-hook conflict between two spec-declared plugins, naming both", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const registry = createDefaultPluginRegistry();
		registry.register({ name: "shaper", hooks: ["tool_result"], factory: () => ({}) as never });
		registry.register({ name: "trimmer", hooks: ["tool_result"], factory: () => ({}) as never });

		await expect(
			assemble({
				pluginContext: pluginContext(),
				spec: spec({ extraPlugins: ["shaper", "trimmer"] }),
				profile,
				registry,
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/replacing hook "tool_result".*"shaper".*"trimmer"/s);
	});

	// 接替原第 2 条(`expect([...shared.names()]).toEqual([])`,锁"内置描述符绝不写进
	// registry")。limits 现在**本来就在**表里,那条断言的前提消失,换成更强的不变量:
	// 同一个 registry 连续两次 assemble 既不撞 already-registered,表内容也没被写脏
	// (assemble 只 lookup 不 register),且两次的 per-run LimitState 互不串。
	it("reuses one registry across two assemblies without already-registered, keeping limit state per-run", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([fauxAssistantMessage("first")]);
		const shared = createDefaultPluginRegistry();
		const stateA: LimitState = { turns: 0 };
		const stateB: LimitState = { turns: 0 };

		const first = await assemble({
			pluginContext: pluginContext({ limitState: stateA }),
			spec: spec(),
			profile,
			registry: shared,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(first.dispose);
		const second = await assemble({
			pluginContext: pluginContext({ limitState: stateB }),
			spec: spec(),
			profile,
			registry: shared,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(second.dispose);

		// 进程级表没被写脏:两次装配都只 lookup,没有任何 per-run 东西 register 进去。
		expect([...shared.names()]).toEqual(["limits"]);

		// 只驱动第一个 session,第二个的 LimitState 必须纹丝不动。
		await first.session.prompt("hi");
		expect(stateA.turns).toBe(1);
		expect(stateB.turns).toBe(0);
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
			pluginContext: pluginContext(),
			spec: spec(),
			profile: realProfile,
			registry: createDefaultPluginRegistry(),
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
				pluginContext: pluginContext(),
				spec: spec(),
				profile: missingProfile,
				registry: createDefaultPluginRegistry(),
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
			pluginContext: pluginContext(),
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: sharedToolsets,
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		const second = await assemble({
			pluginContext: pluginContext(),
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
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
		const conflictingPlugins = createDefaultPluginRegistry();
		conflictingPlugins.register({ name: "a", hooks: ["tool_result"], factory: () => ({}) as never });
		conflictingPlugins.register({ name: "b", hooks: ["tool_result"], factory: () => ({}) as never });

		await expect(
			assemble({
				pluginContext: pluginContext(),
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
