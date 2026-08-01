import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { assemble } from "../src/runtime/assembler.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { resolveSpecPromptPaths } from "../src/spec/resolve-prompt-paths.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness } from "./helpers/faux.ts";

const specDir = fileURLToPath(new URL("../specs/", import.meta.url));
const spec = JSON.parse(readFileSync(`${specDir}policy-query.json`, "utf8")) as Record<string, unknown>;

describe("出厂 spec: policy-query.json", () => {
	it("ships the output contract through appendSystemPrompt, not buried in system.md", () => {
		expect(spec.appendSystemPrompt).toEqual(["policy-query/output-format.md"]);
	});

	it("no longer carries the output-format section inside system.md", () => {
		const systemMd = readFileSync(`${specDir}policy-query/system.md`, "utf8");
		expect(systemMd).not.toContain("输出格式");
		expect(systemMd).toContain("取证顺序"); // 其余内容还在,不是把文件删空了
	});

	it("keeps the seven legal basis keys and the no-text rule in the appended contract", () => {
		const contract = readFileSync(`${specDir}policy-query/output-format.md`, "utf8");
		for (const key of ["conclusion", "basis", "confidence", "finish_reason"]) {
			expect(contract).toContain(key);
		}
		// basis[] 不得含条款原文 —— 既是权限红线也防篡改(规格 §4.1)。
		expect(contract).toContain("不要");
		expect(contract).toContain("text");
	});

	// output-contract.ts:42-59 那条寄生前提的静态半边:schema 少了这个 required,
	// 反幻觉兜底会静默消失而所有测试照常通过。动态半边是 Task 18 的 A8。
	it("requires clause_id on every basis element — the anti-hallucination carrier", () => {
		const schema = JSON.parse(readFileSync(`${specDir}policy-query/output-contract.schema.json`, "utf8")) as {
			properties: { basis: { items: { required: string[] } } };
		};
		expect(schema.properties.basis.items.required).toContain("clause_id");
	});
});

const fauxProfile: ProviderProfile = {
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

function fauxPluginContext(): Omit<PluginContext, "callTool"> {
	return {
		getRunId: () => "r1",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: () => {},
		getRunInput: () => "",
	};
}

/**
 * 出厂 spec 声明的 `toolset` 是 `"policy-query"`,`tools` 是真实的 5 个查询工具名 ——
 * `assemble()` 只用 `spec.toolset` / `spec.tools` 做交叉校验,从不读 `spec.mcpServers`
 * (那个字段只被 `createDefaultRuntimeFactory` / `cli/main.ts` 用来接真实 MCP 子进程)。
 * 所以这里可以喂一个假 toolset —— 5 个从不会被真的调用的桩工具,只是为了让
 * `assemble()` 的工具白名单交叉校验通过,不需要真实的 `${DFZQ_AUDIT_AI_PYTHON}` 解释器。
 */
function policyQueryToolsets(toolNames: string[]): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("policy-query", async () =>
		toolNames.map(
			(name) =>
				({
					name,
					label: name,
					description: "stub for prompt-resolution test — this tool is never actually called",
					parameters: Type.Object({}),
					execute: async () => ({ output: "", content: "" }),
				}) as never,
		),
	);
	return registry;
}

/** 每次都重新读盘、重新 parse —— 不能复用上面 describe 用的模块级 `spec` 常量,
 *  这条 describe 会就地改写 systemPrompt / appendSystemPrompt(resolveSpecPromptPaths 是
 *  就地修改),复用同一个对象会让上面那 4 条静态断言(检查 appendSystemPrompt 还是原始
 *  路径数组)在执行顺序不巧的情况下读到已经被改写成正文的字段。 */
function freshRuntimeSpec(): RuntimeSpec & { toolset: string; tools: string[] } {
	return JSON.parse(readFileSync(`${specDir}policy-query.json`, "utf8"));
}

describe("出厂 spec 的 prompt 路径真的会被解析(不是字面字符串)", () => {
	// 🔴 这条用例守的是一个静默了整整一轮的缺口:pi 的 resolvePromptInput
	// (packages/coding-agent/src/core/resource-loader.ts:53-67)是
	// `existsSync(input) ? readFileSync(input) : input` —— 路径读不到就把路径本身当 prompt
	// 正文,不报错不告警。而 task-runtime 此前只对 skills 与 outputContract.schema 做了
	// resolve(specsDir, rel),systemPrompt 与 appendSystemPrompt 原样透传 ⇒ 模型收到的是
	// 字面路径字符串。
	//
	// 既有用例(test/assembler.test.ts)全部传字面文本("You are a test agent." 之类),
	// 走的正是那条 fallthrough 分支 —— 实现对错都通过,零区分力。所以这里必须用**真实
	// specs/policy-query.json 的真实路径值**,并且必须经过生产的解析代码
	// (resolveSpecPromptPaths,现在是 ../src/spec/resolve-prompt-paths.ts 的独立模块,
	// server/main.ts 与 cli/main.ts 都从这里 import)—— 不能在测试里自己另起一套"看起来像"
	// 的解析逻辑,否则这条用例测的是测试自己的实现,不是生产代码。
	//
	// 为什么不直接走 createDefaultRuntimeFactory 返回的 RuntimeFactory:那条路径经
	// createSessionRuntime 只交回 contract.ts 的 Runtime,不暴露 assemble() 产出的
	// Assembled.session,够不到这里要断言的 assembled.session.systemPrompt;而出厂 spec 的
	// mcpServers 需要真实的 ${DFZQ_AUDIT_AI_PYTHON} 解释器,不该是这条单测的依赖。所以改为
	// 直接调用 resolveSpecPromptPaths(生产代码本体)+ assemble()(与 test/assembler.test.ts
	// 的 fake-toolset / faux-model 装配套路同构),换掉的只是"怎么拿到 MCP 工具",不是
	// "谁来解析 systemPrompt 的路径"。
	//
	// ⚠️ 这里直接调用 resolveSpecPromptPaths,**不经过** createDefaultRuntimeFactory 构造期
	// for 循环里的调用点——那个调用点本身有没有真的接上,是审查 Critical-2 之后另一条独立的
	// 覆盖面,见 test/server-startup.test.ts 的
	// "createDefaultRuntimeFactory - systemPrompt / appendSystemPrompt resolution" 那个
	// describe(用临时 specsDir + 坏路径,断言 createDefaultRuntimeFactory() 本身响亮失败)。
	// 这条区分是 Task 15d 复审 Critical-1 的教训:早先这里的注释错误地声称"for 循环调用点被
	// 去掉,这条用例会跟着翻红",但这条用例走的是函数直调,够不到那个调用点,那句断言是假的。
	async function assembleRealSpec() {
		const runtimeSpec = freshRuntimeSpec();
		await resolveSpecPromptPaths(runtimeSpec, specDir);
		const harness = await createFauxHarness();
		const assembled = await assemble({
			pluginContext: fauxPluginContext(),
			spec: runtimeSpec,
			profile: fauxProfile,
			registry: createDefaultPluginRegistry(),
			toolsets: policyQueryToolsets(runtimeSpec.tools),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		return {
			assembled,
			cleanup: async () => {
				await assembled.dispose();
				await harness.cleanup();
			},
		};
	}

	it("assembles the real system.md body, not the path string", async () => {
		const { assembled, cleanup } = await assembleRealSpec();
		try {
			expect(assembled.session.systemPrompt).toContain("取证顺序(必须遵守)");
			expect(assembled.session.systemPrompt).not.toContain("policy-query/system.md");
		} finally {
			await cleanup();
		}
	});

	it("assembles the real output-format.md body, not the path string", async () => {
		const { assembled, cleanup } = await assembleRealSpec();
		try {
			// brief 建议的锚点 "basis[] 的元素只能有" 里那个 "]" 后面紧跟着 Markdown 的反引号
			// (源文件是 "`basis[]` 的元素只能有"),不是连续子串 —— 换一句不含反引号断点的话。
			expect(assembled.session.systemPrompt).toContain("的元素只能有上面列出的这七个键");
			expect(assembled.session.systemPrompt).not.toContain("policy-query/output-format.md");
		} finally {
			await cleanup();
		}
	});
});

function demoToolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "stub for the literal-appendSystemPrompt test — never actually called",
			parameters: Type.Object({}),
			execute: async () => ({ output: "", content: "" }),
		} as never,
	]);
	return registry;
}

// 审查复审 Important-5 的正向对照:test/server-startup.test.ts 里 "accepts a literal
// appendSystemPrompt entry..." 那条只证明了 createDefaultRuntimeFactory() 构造不抛(wiring
// 层面);这里补上内容层面的证据——不形似路径的字面文本真的原样到达了 assemble() 产出的
// AgentSession 的 systemPrompt 正文,不是被 looksLikePath() 的新判据顺手吞掉或改写。
describe("appendSystemPrompt 的字面文本分支真的会到达 systemPrompt(Important-5 正向对照)", () => {
	it("a literal (non-path-looking) appendSystemPrompt entry reaches the assembled system prompt verbatim", async () => {
		const runtimeSpec: RuntimeSpec & { toolset: string; tools: string[] } = {
			id: "literal-append-demo",
			model: { role: "main" },
			toolset: "demo",
			tools: ["echo"],
			limits: { maxTurns: 5 },
			appendSystemPrompt: ["SOME-LITERAL-CONTRACT-TEXT"],
		};
		await resolveSpecPromptPaths(runtimeSpec, specDir);
		// "SOME-LITERAL-CONTRACT-TEXT" 不含 "/",也不以 .md / .json 结尾 —— looksLikePath()
		// 判它不形似路径,resolveSpecPromptPaths 必须原样放行,不碰文件系统、不抛、不改写。
		expect(runtimeSpec.appendSystemPrompt).toEqual(["SOME-LITERAL-CONTRACT-TEXT"]);

		const harness = await createFauxHarness();
		const assembled = await assemble({
			pluginContext: fauxPluginContext(),
			spec: runtimeSpec,
			profile: fauxProfile,
			registry: createDefaultPluginRegistry(),
			toolsets: demoToolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		try {
			expect(assembled.session.systemPrompt).toContain("SOME-LITERAL-CONTRACT-TEXT");
		} finally {
			await assembled.dispose();
			await harness.cleanup();
		}
	});
});
