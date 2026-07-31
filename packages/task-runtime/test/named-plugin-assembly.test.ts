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
			specId: "named-plugins-probe",
			getRunId: () => "run-1",
			getRunInput: () => runInput,
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

	it("fails loudly when the registry has no sufficiency-gate (assess not wired)", async () => {
		harness = await createFauxHarness();
		await expect(
			assemble({
				spec: await loadSpec(),
				profile,
				registry: createDefaultPluginRegistry(), // 没传 assess
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				pluginContext: {
					specId: "named-plugins-probe",
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
		).rejects.toThrow(/plugin "sufficiency-gate" is not registered/);
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
					specId: "named-plugins-probe-minimal",
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
