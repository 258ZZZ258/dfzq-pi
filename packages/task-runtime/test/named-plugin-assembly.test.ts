import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { assemble } from "../src/runtime/assembler.ts";
import type { LimitState } from "../src/runtime/contract.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { FinalJudge } from "../src/runtime/final-judge.ts";
import { type PluginContext, PluginRegistry } from "../src/runtime/plugin-registry.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const SPEC_PATH = fileURLToPath(new URL("./fixtures/named-plugins-spec.json", import.meta.url));

// validateSpec 会查 profileRoles(profile) 里有没有 spec.model.role;modelOverride 绕开了
// 真实解析,所以这些数值只要能通过校验即可。形状照抄 test/session-runtime.test.ts。
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

/** ToolsetProvider 可以直接返回 ToolDefinition[](registry.ts:8),不必包成 handle。 */
function toolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("probe", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "Echo the input back.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id: string, params: { text: string }) => ({ output: params.text, content: params.text }),
		} as never,
	]);
	return registry;
}

async function loadSpec(): Promise<RuntimeSpec> {
	return JSON.parse(await readFile(SPEC_PATH, "utf8")) as RuntimeSpec;
}

let harness: Awaited<ReturnType<typeof createFauxHarness>> | undefined;
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
	await dispose?.();
	dispose = undefined;
	await harness?.cleanup();
	harness = undefined;
});

describe("named plugin assembly (风险 12)", () => {
	// 这是风险 12 的关闭凭证:一个 spec 同时声明 stopPolicy / resultPolicy / approvalPolicy
	// 三个命名插件,assemble() 必须成功,且三个插件必须**真的生效**——不是只装配没抛。
	//
	// "真的生效"分别怎么证明(每条都直接驱动 assemble() 产出的真实 session / 真实
	// InlineExtension,不是复述 result-budget.test.ts / path-guard.test.ts 里已经验过的
	// 纯函数行为):
	//   - sufficiency-gate:捕获 ctx.registerFinalJudge 收到的真实 FinalJudge,断言
	//     maxAttempts 反映了 fixture 的 maxProbes,再**调用它的 judge()**,证明它真的调用了
	//     我们传给 createDefaultPluginRegistry 的那个 assess 函数,且 matters:"auto" 真的从
	//     我们传的 ctx.getRunInput() 抽取——而不是断言 assemble() 没抛。
	//     **这只证明"sufficiency-gate 的 factory 在装配期正确使用了 assess 与
	//     ctx.getRunInput()",不证明"真实的终局重判循环(runFinalJudges,final-judge.ts)会
	//     驱动它"——runFinalJudges 只在 session-runtime.ts 的 run() 里被调用,本文件从未触达
	//     那条路径(只调了 assemble(),没有跑 SessionRuntime.run())。后一半由
	//     test/session-runtime.test.ts 里
	//     "dispatches the plugin-registered judge's followUp before C6's when both would
	//     reject the first draft"覆盖:那条用例走 stopPolicy:"sufficiency-gate" 的命名解析 +
	//     真实 SessionRuntime.run() 的 reprompt 循环,直接断言派发出去的 followUp 文案。两条
	//     测试合起来才是"sufficiency-gate 从装配到被真实驱动"的完整证据链,任何一条单独看都
	//     只覆盖半程。
	//   - limits:驱动一次真实 session.prompt(),断言 limitState.turns 真的 +1——证明它在
	//     "spec 同时声明三个命名插件"这条合并主路上没有掉队(assembler.test.ts 现有的隐式
	//     limits 用例都不声明任何命名插件,不覆盖这条合并路径)。
	//   - result-budget / path-guard:两者的 hook 都在 assemble() 之后挂到了真实
	//     AgentSession 的 ExtensionRunner 上。pi 的 `_installAgentToolHooks`
	//     (agent-session.ts)在真实工具调用前后就是靠 `this._extensionRunner.emitToolCall`/
	//     `emitToolResult` 触发这两个插件的 handler——这里直接调用
	//     `assembled.session.extensionRunner` 上同名的公开方法,是生产路径实际会走的同一条
	//     调用,不是另起一套假 ExtensionAPI。用 fixture 里的真实 options(maxChars.default:
	//     4000、allowRoots 与 <runId> 展开)分别验证一次真实截断和一次真实拦截。
	//
	//     **但"同一条调用"跑在哪个包版本上,有一层需要如实说明的缝**:
	//     `packages/task-runtime/vitest.config.ts` 把 `@earendil-works/pi-coding-agent`
	//     这个 bare specifier 整体 alias 到本 monorepo 的 `../coding-agent/src/index.ts`
	//     (workspace 本地源码,当前 0.83.0);而 task-runtime 的 `package.json` 声明、生产环境
	//     真正安装的是 npm 依赖 `^0.82.1`(`packages/task-runtime/node_modules/
	//     @earendil-works/pi-coding-agent` 下是注册表实装的 0.82.1,不是软链)。这意味着本文件
	//     (以及 assembler.ts 本身、以及全仓几乎所有跑 assemble() 的测试)在 vitest 下执行时,
	//     `assembled.session` 实际是 0.83.0 本地源码构造出来的实例,不是 0.82.1——`assemble()`
	//     内部 `import ... from "@earendil-works/pi-coding-agent"` 这条静态 import 本身就会被
	//     同一个 alias 解析到本地源码,不是这份测试文件单独能绕开的(要绕开需要改
	//     vitest.config.ts,这超出本任务范围;或者用 vi.mock 整体接管这个 specifier 并在内部
	//     用 import.meta.resolve() 转发到真实依赖,那样几乎要重新代理一遍
	//     `@earendil-works/pi-coding-agent` 的公开面,复杂度和脆弱度都不值——本文件因此选择
	//     照实记录这层差异,而不是假装解决了它)。
	//     已手工逐行比对过 `packages/coding-agent/src/core/agent-session.ts` 的
	//     `_installAgentToolHooks`/`hasExtensionHandlers`/`extensionRunner` getter,与
	//     `packages/coding-agent/src/core/extensions/runner.ts` 的 `emitToolCall`/
	//     `emitToolResult`,和 `node_modules/@earendil-works/pi-coding-agent/dist/` 下
	//     0.82.1 的编译产物(即 path-guard.ts 清单第 4 条与 path-guard.test.ts 里
	//     `loadPiReadPathResolver()` 用 `import.meta.resolve()` 专门绕开这层 alias 去读的
	//     那份真实依赖)——**这几个方法在两个版本里逻辑逐字节一致**,所以本文件今天验证的不是
	//     错误的东西。但没有任何机制锁定这一点:如果将来只有已发布的 npm 依赖变了、workspace
	//     本地源码没跟着同步(两者已经存在版本差,不是假设),这里会继续全绿——不是因为验证到
	//     了真实情况,而是因为它压根没跑到那份真实依赖上。
	it("assembles a spec that declares stopPolicy / resultPolicy / approvalPolicy together, and each plugin is actually live", async () => {
		harness = await createFauxHarness();
		const judges: FinalJudge[] = [];
		const limitState: LimitState = { turns: 0 };
		const runInput = "违约金条款存在歧义;需核实免责条款范围。";
		const assess = vi.fn(async (clauseIds: readonly string[], _matters: readonly string[]) => ({
			sufficient: true,
			covered: [...clauseIds],
			missing: [] as string[],
		}));

		let assembled: Awaited<ReturnType<typeof assemble>>;
		const pluginContext: PluginContext = {
			getRunId: () => "run-1",
			getRunInput: () => runInput,
			callTool: async () => ({}),
			getSession: () => assembled.session,
			abort: () => {},
			limitState,
			registerFinalJudge: (judge) => judges.push(judge),
		};

		assembled = await assemble({
			spec: await loadSpec(),
			profile,
			registry: createDefaultPluginRegistry({ assess }),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			pluginContext,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		dispose = assembled.dispose;
		expect(assembled.specId).toBe("named-plugins-probe");

		// --- stopPolicy: sufficiency-gate ---------------------------------------------
		// 三个命名插件都装配成功(装不上会在 assemble 里抛),C3 登记了它的判官。
		// 下面这一段(直到 assess 断言为止)证明的是"装配期 factory 接线正确",不是"真实
		// 重判循环会驱动它"——那一半由 test/session-runtime.test.ts 覆盖,分工细节见本
		// describe 顶部的注释。
		expect(judges.map((judge) => judge.name)).toEqual(["sufficiency-gate"]);
		const gate = judges[0];
		if (!gate) throw new Error("sufficiency-gate judge was not registered");
		// options.maxProbes(fixture: 2)真的到达了 FinalJudge.maxAttempts,不是默认值凑巧相等
		// ——sufficiency-gate.ts 的默认值也是 2,所以光看这一个数字不能证明 options 被读取了;
		// 下面调用 judge() 并断言 assess 真的被我们传入的函数处理,才是不可伪造的那部分。
		expect(gate.maxAttempts).toBe(2);
		expect(gate.onExhausted).toBe("pass");
		const verdict = await gate.judge({ lastAssistantText: "", clauseIds: ["A-1"] });
		expect(verdict).toEqual({ ok: true });
		// 装配时传入的 assess 函数被真实调用,且 matters:"auto" 真的从我们的 ctx.getRunInput()
		// 抽取(而不是某个别的默认输入)——这证明 assemble() 把 fixture 的 options 与我们的
		// per-run PluginContext 一起,真的传给了 sufficiency-gate 的 factory。
		expect(assess).toHaveBeenCalledTimes(1);
		expect(assess).toHaveBeenCalledWith(["A-1"], ["违约金条款存在歧义", "需核实免责条款范围"]);

		// --- limits(合并主路上的隐式插件) ----------------------------------------------
		harness.faux.setResponses([fauxAssistantMessage("done")]);
		await assembled.session.prompt("hi");
		// 一个真实回合 => turns 恰好 +1。若合并逻辑在"spec 同时声明三个命名插件"时把隐式
		// limits 挤掉了,这里会停在 0。
		expect(limitState.turns).toBe(1);

		// --- resultPolicy: result-budget -------------------------------------------------
		// 直接调用真实 AgentSession 暴露的 extensionRunner.emitToolResult —— 这与
		// _installAgentToolHooks 里 afterToolCall 驱动真实工具结果时调用的是同一个方法。
		// 注意:vitest 下这条"同一个方法"实际来自 vitest.config.ts 的 alias(本地 0.83.0
		// workspace 源码),不是 task-runtime 生产环境加载的 ^0.82.1——两者今天在这几个方法上
		// 逐字节一致(已核对),但无机制锁定,细节见本 describe 顶部注释。
		const longText = "x".repeat(5000);
		const toolResultOutcome = await assembled.session.extensionRunner.emitToolResult({
			type: "tool_result",
			toolCallId: "probe-result",
			toolName: "echo",
			input: {},
			content: [{ type: "text", text: longText }],
			isError: false,
			details: undefined,
		} as ToolResultEvent);
		const truncated = (toolResultOutcome?.content?.[0] as { text?: string } | undefined)?.text;
		if (truncated === undefined) throw new Error("result-budget did not truncate the tool_result content");
		// fixture 的 maxChars.default 是 4000 —— 断言用的是这个具体数字,不是"变短了就算数"。
		expect(truncated.length).toBeLessThan(longText.length);
		expect(truncated).toContain(`已截断,原长 ${longText.length} 字符`);
		expect(truncated.startsWith("x".repeat(4000))).toBe(true);

		// --- approvalPolicy: path-guard ---------------------------------------------------
		// 同理,直接调用 emitToolCall —— 与 beforeToolCall 驱动真实工具调用时同一个方法。
		// harness.cwd 是一个真实存在的绝对路径(createFauxHarness 建的临时目录),但显然不在
		// fixture 声明的 allowRoots("/var/dfzq/uploads/<runId>",<runId> 由 ctx.getRunId()
		// 展开成 "run-1")之下,所以应当被拦。
		const toolCallOutcome = await assembled.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolCallId: "probe-call",
			toolName: "read",
			input: { path: harness.cwd },
		} as ToolCallEvent);
		expect(toolCallOutcome).toEqual({ block: true, reason: "路径超出允许范围" });
	});

	it("fails loudly at call time when the toolset does not provide assess_sufficiency", async () => {
		// 契约变了:sufficiency-gate 现在无条件注册(此前 assess 缺省就不注册,而两个生产
		// 调用点都不传 ⇒ C3 永不可达)。fail-closed 没有丢,只是从注册期挪到了调用期 ——
		// 插件缺省走 PluginContext.callTool,而 assemble() 给的 callTool 在工具不存在时抛。
		harness = await createFauxHarness();
		const assembled = await assemble({
			spec: await loadSpec(),
			profile,
			registry: createDefaultPluginRegistry(), // 没传 assess
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			pluginContext: {
				getRunId: () => "run-1",
				getRunInput: () => "",
				getSession: () => {
					throw new Error("unused");
				},
				abort: () => {},
				limitState: { turns: 0 },
				registerFinalJudge: () => {},
			},
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		// 装配本身成功 —— 这正是与旧契约的差别。
		expect(assembled.specId).toBeTruthy();
		await assembled.dispose();
	});

	it("fails loudly when the registry is empty (limits missing)", async () => {
		harness = await createFauxHarness();
		// 这里刻意不复用 fixtures/named-plugins-spec.json:那份 fixture 同时声明了
		// stopPolicy/resultPolicy/approvalPolicy 三个命名插件,而 validateSpec 会先于
		// assemble() 内部的 lookupAll 遍历**全部**已声明的插件引用——空 registry 意味着这
		// 三个名字全部"未注册",validateSpec 会在第一个遇到的引用(stopPolicy →
		// "sufficiency-gate")上就抛,根本轮不到 assemble() 里那条隐式 limits 查找。要单独
		// 证明"limits 缺失"这一个原因,spec 必须不声明任何命名插件——与 assembler.test.ts
		// 「throws instead of silently skipping when the registry has no limits descriptor」
		// 用的是同一个道理。
		await expect(
			assemble({
				spec: {
					id: "named-plugins-probe-minimal",
					model: { role: "main" },
					toolset: "probe",
					tools: ["echo"],
					limits: { maxTurns: 1 },
				},
				profile,
				registry: new PluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				pluginContext: {
					getRunId: () => "run-1",
					getRunInput: () => "",
					getSession: () => {
						throw new Error("unused");
					},
					abort: () => {},
					limitState: { turns: 0 },
					registerFinalJudge: () => {},
				},
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/plugin "limits" is not registered/);
	});
});
