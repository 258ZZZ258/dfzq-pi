import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		getRunId: () => "r1",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: () => {},
		getRunInput: () => "",
		callTool: async () => ({}),
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

	// 契约硬化(规格 §1.1):契约必须落在整篇 systemPrompt **之后**。
	// ⚠ 这不是"放在最后"—— buildSystemPrompt 在 appendSystemPrompt 之后还会追加
	// skills 摘要与 "Current working directory:" 行(system-prompt.ts:41-71)。
	// 断言只钉住"在 systemPrompt 之后",不谎称末位。
	it("places appendSystemPrompt after the entire systemPrompt body", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			pluginContext: pluginContext(),
			spec: spec({
				systemPrompt: "HEAD-MARKER 前置指引正文 TAIL-MARKER",
				appendSystemPrompt: ["CONTRACT-MARKER"],
			}),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		const prompt = assembled.session.systemPrompt;
		expect(prompt.indexOf("CONTRACT-MARKER")).toBeGreaterThan(prompt.indexOf("TAIL-MARKER"));
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

	// Regression lock (review I-1):limits 进 registry 后,"limits" 成了一个**可解析的名字**,
	// 于是 spec 能二次声明它 —— validateSpec 只查 knownPlugins 会放行,lookupAll 解析出第二个
	// 条目,而 turn_end 是观察型 hook,替换型冲突校验不拦。两个实例共享同一个 ctx.limitState、
	// 各自 turns += 1,maxTurns:5 在第 3 个真实回合就触发(实测 handlers mounted: 2)。
	// 装配期必须响亮拒绝,**不许静默去重** —— 静默去重会让写错 spec 的人永远不知道写错了。
	// 这条缝是本次重构引入的:旧路径 registry 恒空,validateSpec 会先抛 `not registered`。
	it.each([
		["extraPlugins", { extraPlugins: ["limits"] }],
		["stopPolicy", { stopPolicy: "limits" }],
	])("rejects a spec that re-declares the implicitly mounted limits plugin via %s", async (_field, overrides) => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				pluginContext: pluginContext(),
				spec: spec(overrides),
				profile,
				registry: createDefaultPluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/"limits" is mounted implicitly from spec\.limits and must not be declared as a plugin ref/);
	});

	// 只挂一次 —— 上面那条锁的是"重复声明被拒",这条锁的是"正常路径确实只有一个实例"。
	// 没有它,把隐式 ref 整个删掉(limits 一次都不挂)也能让上面那条继续绿。
	it("mounts exactly one limits instance on the normal path", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([fauxAssistantMessage("once")]);
		const state: LimitState = { turns: 0 };
		const assembled = await assemble({
			pluginContext: pluginContext({ limitState: state }),
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);

		// 一个真实回合 => turns 恰好 +1。挂了两个实例的话这里会是 2。
		await assembled.session.prompt("hi");
		expect(state.turns).toBe(1);
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
		expect([...shared.names()]).toEqual(["limits", "result-budget", "path-guard", "sufficiency-gate"]);

		// 只驱动第一个 session,第二个的 LimitState 必须纹丝不动。
		await first.session.prompt("hi");
		expect(stateA.turns).toBe(1);
		expect(stateB.turns).toBe(0);
	});

	// 复审 M-4:above 那两条 it.each 只锁了"limits 这一个特定名字"的重复声明 —— 那是
	// assembler.ts 里的专项拒绝(限定检查 spec.stopPolicy/extraPlugins 有没有再写一遍
	// "limits")。这里证明通用路径(instantiatePlugins 的重名校验)对**任意**插件名都成立,
	// 不依赖那条专项检查:一个真的往 ctx.registerFinalJudge 塞状态的插件(照着 sufficiency-gate
	// 的形状)同时被 stopPolicy 与 extraPlugins 声明,若没有这条保护,会被实例化两次、
	// 把同一个判官注册两次 —— 这正是复审点名的"assess 调用与探测轮次悄悄翻倍"的具体后果,
	// 不只是一个抽象的错误分支。
	it("rejects the same custom plugin declared via two different spec fields, before it can register per-run state twice", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const registry = createDefaultPluginRegistry();
		const judges: unknown[] = [];
		registry.register({
			name: "probe",
			hooks: [],
			factory: (ctx) => {
				ctx.registerFinalJudge({
					name: "probe",
					maxAttempts: 1,
					onExhausted: "pass",
					judge: async () => ({ ok: true }),
				});
				return { name: "probe", factory: () => {} };
			},
		});

		await expect(
			assemble({
				pluginContext: pluginContext({ registerFinalJudge: (judge) => judges.push(judge) }),
				spec: spec({ stopPolicy: "probe", extraPlugins: ["probe"] }),
				profile,
				registry,
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/plugin "probe" is declared more than once/);
		// 装配期就地拒绝 —— judges 里一次注册都不该出现,不是"注册了两次,只是报个警告"。
		expect(judges).toHaveLength(0);
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

describe("PluginContext.callTool(C3 接线)", () => {
	it("hands plugins a callTool bound to this run's resolved tools", async () => {
		// 这是插件够得着 per-run MCP 会话的唯一通路:PluginRegistry 是进程级的,
		// MCP client 是 per-run 的,那根线在注册处接不上。
		let called: { name: string; args: unknown } | undefined;
		let result: unknown;
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "probe-calltool",
			hooks: [],
			factory: (ctx) => {
				void ctx.callTool("echo", { text: '{"ok":true}' }).then((r) => {
					result = r;
				});
				called = { name: "echo", args: { text: "x" } };
				return { name: "probe-calltool", factory: () => {} };
			},
		});
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			spec: spec({ extraPlugins: ["probe-calltool"] }),
			profile,
			registry,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			pluginContext: pluginContext(),
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		await new Promise((r) => setTimeout(r, 10));
		expect(called).toBeTruthy();
		// echo fixture 回显 text,内容是合法 JSON ⇒ callTool 解析后交回对象
		expect(result).toEqual({ ok: true });
	});

	it("throws a diagnostic error when the plugin asks for a tool this toolset lacks", async () => {
		// 装配错误要响要早,且要说清是哪个工具、有哪些可用 ——
		// 「C1 有没有接上」这个问题就是靠它回答的。
		let thrown: Error | undefined;
		const registry = createDefaultPluginRegistry();
		registry.register({
			name: "probe-missing-tool",
			hooks: [],
			factory: (ctx) => {
				void ctx.callTool("no-such-tool", {}).catch((e) => {
					thrown = e as Error;
				});
				return { name: "probe-missing-tool", factory: () => {} };
			},
		});
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			spec: spec({ extraPlugins: ["probe-missing-tool"] }),
			profile,
			registry,
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			pluginContext: pluginContext(),
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		await new Promise((r) => setTimeout(r, 10));
		expect(thrown?.message).toMatch(/no-such-tool/);
		expect(thrown?.message).toMatch(/does not provide/);
	});

	it("exposes callTool on the assembled result", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			spec: spec(),
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			pluginContext: pluginContext(),
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		await expect(assembled.callTool("echo", { text: "hi" })).resolves.toBeDefined();
	});
});

describe("C7:spec 声明的 skill 注入", () => {
	async function assembleWithSkills(skillPaths: string[] | undefined) {
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
			skillPaths,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		return assembled;
	}

	it("loads a declared skill even though noSkills is true", async () => {
		// §2.4-V2 的结论此前只有读码依据。这条是它的判别性验证:
		// noSkills:true 只过滤磁盘扫描,不挡构造选项传进来的 skill。
		const dir = await mkdtemp(join(tmpdir(), "dfzq-skill-"));
		cleanups.push(async () => {
			await rm(dir, { recursive: true, force: true });
		});
		const file = join(dir, "policy-validity.md");
		await writeFile(file, "---\nname: policy-validity\ndescription: 判定制度的现行有效性\n---\n\n正文\n");

		const assembled = await assembleWithSkills([file]);
		const { skills } = assembled.resources.getSkills();
		expect(skills.map((s) => s.name)).toContain("policy-validity");
	});

	it("loads no skills when the spec declares none", async () => {
		// 对照组:没有这条,上面那条无法排除「底座本来就在加载磁盘 skill」。
		const assembled = await assembleWithSkills(undefined);
		expect(assembled.resources.getSkills().skills).toHaveLength(0);
	});
});

describe("Assembled.callTool", () => {
	it("直接调本次装配的工具,不经 agent loop", async () => {
		const harness = await createFauxHarness();
		const registry = new ToolsetRegistry();
		const calls: Array<Record<string, unknown>> = [];
		registry.register("t", async () => [
			{
				name: "echo",
				label: "echo",
				description: "faux",
				parameters: Type.Object({ v: Type.String() }),
				execute: async (_id: string, params: Record<string, unknown>) => {
					calls.push(params);
					const payload = JSON.stringify({ got: params.v });
					return { output: payload, content: payload };
				},
			} as never,
		]);
		const assembled = await assemble({
			spec: {
				id: "x",
				model: { role: "main" },
				toolset: "t",
				tools: ["echo"],
				limits: { maxTurns: 1 },
			},
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: registry,
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			pluginContext: {
				getRunId: () => "r1",
				getSession: () => assembled.session,
				abort: () => {},
				limitState: { turns: 0 },
				registerFinalJudge: () => {},
				getRunInput: () => "",
			},
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		await expect(assembled.callTool("echo", { v: "hi" })).resolves.toEqual({ got: "hi" });
		expect(calls).toEqual([{ v: "hi" }]);
		await assembled.dispose();
		await harness.cleanup();
	});
});
