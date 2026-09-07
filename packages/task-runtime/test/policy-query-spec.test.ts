import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { assemble } from "../src/runtime/assembler.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { deriveFastSpec } from "../src/runtime/fast-path-runtime.ts";
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

	it("caps ordinary policy queries at one search and one detail lookup", () => {
		const systemMd = readFileSync(`${specDir}policy-query/system.md`, "utf8");
		expect(systemMd).toContain("只调用一次 `search_policy`");
		expect(systemMd).toContain("一次 `get_clause_detail`");
	});

	/**
	 * basis[] 的八个合法键 —— 契约正文(output-format.md)与出厂 schema
	 * (output-contract.schema.json 的 basis.items.properties)必须逐字一致,这是下面用例
	 * 断言 1 / 断言 2 共同的单一事实来源。
	 *
	 * 缘由(task-21 复审 必修1):此前用例名承诺"守七个 basis 键",循环里检查的却全是顶层键
	 * (conclusion/basis/confidence/finish_reason),basis 内部七个键一个都没检 —— 终审变异
	 * 实测:把 output-format.md 里的七键 JSON 示例整段换成 `{ }`、删掉"只能有上面列出的这
	 * 七个键"那句,这条用例仍然全绿(彼时循环只剩正文散句里侥幸命中的 source_code)。
	 * 真实后果不是风格问题:出厂 schema 只 `required` 了 clause_id,其余七个键(尤其
	 * source_code —— 下游按它回查权威库装配条款正文)只在 output-format.md 里被要求。
	 * source_code 一旦从契约正文掉了,模型不再输出它,schema 照样过、判官照样过,下游装配却
	 * 会断,全链零信号。
	 */
	const BASIS_KEYS = [
		"clause_id",
		"doc_title",
		"clause_path",
		"status",
		"source_code",
		"source_doc_id",
		"corpus_type",
		"score",
		"text",
	] as const;
	const FAST_BASIS_KEYS = BASIS_KEYS.filter((key) => key !== "text");

	it("keeps the nine basis keys in lockstep between output-format.md's contract text and the schema's key set", () => {
		const contract = readFileSync(`${specDir}policy-query/output-format.md`, "utf8");
		for (const key of ["conclusion", "basis", "confidence", "finish_reason"]) {
			expect(contract).toContain(key);
		}
		expect(contract).toContain("text");

		// 断言 1:八个 basis 键必须逐个真的出现在契约正文里 —— 不是只在无关散句里侥幸命中。
		for (const key of BASIS_KEYS) {
			expect(contract).toContain(key);
		}

		// 断言 2:schema 的 basis.items.properties 键集必须恰好等于这八个键,多一个少一个都要
		// 翻红。sort() 只是让比较不依赖 JSON 属性声明顺序,不是放宽成"包含即可"——两侧都
		// sort 之后用 toEqual 做精确比较,不是 toContain/arrayContaining。
		const schema = JSON.parse(readFileSync(`${specDir}policy-query/output-contract.schema.json`, "utf8")) as {
			properties: { basis: { items: { properties: Record<string, unknown> } } };
		};
		expect(Object.keys(schema.properties.basis.items.properties).sort()).toEqual([...BASIS_KEYS].sort());
	});

	// 2026-08-04 复审 必修1:fast-answer.md 是本分支新增的第二份契约正文(policy-query 提速
	// 规格的两阶段快路径专用,与 output-format.md 共用同一份 output-contract.schema.json)。
	// 上面那条八键联动用例只读 output-format.md —— fast-answer.md 此前唯一的断言是下面
	// "keeps the fast answer prompt carrying the output contract..." 那条的
	// toContain("finish_reason"),八个 basis 键里其余七个(尤其 source_code —— 缺了它
	// 下游按 source_code 回查权威库装配条款正文的那一步会断)完全没人守。这里把同一个
	// BASIS_KEYS 循环也跑一遍 fast-answer.md —— 今天全中,是纯加固,不改变现状。
	it("keeps the eight fast-path basis keys present in fast-answer.md's contract text", () => {
		const contract = readFileSync(`${specDir}policy-query/fast-answer.md`, "utf8");
		for (const key of FAST_BASIS_KEYS) {
			expect(contract).toContain(key);
		}
	});

	// 2026-08-04 定点修复(第二刀):真 run 判负实锤之一是模型在 reasoning 这个自由文本字段里
	// 写了未转义的双引号,JSON 语法断裂。reasoning 不在 schema 的 required 里、类型是
	// string——不输出它完全合法,顺带还少一段自由文本输出。fast-answer.md 因此不该再用一行
	// JSON 示例邀请模型去填它。
	//
	// ⚠ 这里只断言 JSON 示例里不再出现 `"reasoning"` 这个**带双引号的键形态**(它才是诱使模型
	// 抄写出该字段的直接原因),不是断言全文任何地方都不出现"reasoning"这个词 —— 下面那道
	// 显式禁令必须点名这个字段(用反引号 `reasoning` 而非 JSON 双引号)才有意义,两者不是同一
	// 种出现形态,不冲突。全文字面零命中"reasoning"这个约束与"必须写一句明确点名它的禁令"
	// 本身互斥,这里取的是两条要求背后真正要防的事(schema 挡不住的自由文本字段)。
	it("drops the JSON-example reasoning key from fast-answer.md and explicitly tells the model not to emit it", () => {
		const contract = readFileSync(`${specDir}policy-query/fast-answer.md`, "utf8");
		expect(contract).not.toContain('"reasoning"');
		expect(contract).toContain("不要输出 `reasoning` 字段");
	});

	// 2026-08-05 定点修复(第三刀):去掉 reasoning 字段没有根治转义问题 —— 真 run 判负实锤
	// 显示模型在 basis[] 之外、schema 里*必填*的 conclusion 这个自由文本字段里也会写英文直引号
	// (两例:「独立董事最多可以在几家上市公司兼任」在 conclusion 附近断裂于 position 545;
	// 「投顾荐股违规怎么认定」模型用直引号包住了"违规行为"、断裂于 position 112)。conclusion
	// 不能像 reasoning 那样直接从契约里去掉 —— 它是必填字段,唯一能做的是引导模型换一种引用词句
	// 的写法。
	//
	// ⚠ 这条断言只锁"指令文本还在 fast-answer.md 里"这一件事 —— 挡的是有人以后重构/精简这份
	// 契约时把这句顺手删掉。它不能也不试图证明模型会遵守这条指令:提示词指令对模型只是软约束,
	// 13% 基线的转义错误率是否下降,只能靠真实 runFast() 调用观测方向性信号,不是靠这条纯文本
	// 存在性断言。toContain 的字符串特意取到"不要用英文直引号"为止,不含后面解释"为什么"的分句
	// (避免断言过脆 —— 解释句可以改写而不影响这条指令的可执行部分)。
	it("tells the model to use Chinese quotation marks instead of straight double quotes inside string fields", () => {
		const contract = readFileSync(`${specDir}policy-query/fast-answer.md`, "utf8");
		expect(contract).toContain("请用中文引号「」,不要用英文直引号");
	});

	// output-contract.ts:42-59 那条寄生前提的静态半边:schema 少了这个 required,
	// 反幻觉兜底会静默消失而所有测试照常通过。动态半边是 Task 18 的 A8。
	it("requires clause_id on every basis element — the anti-hallucination carrier", () => {
		const schema = JSON.parse(readFileSync(`${specDir}policy-query/output-contract.schema.json`, "utf8")) as {
			properties: { basis: { items: { required: string[] } } };
		};
		expect(schema.properties.basis.items.required).toContain("clause_id");
	});

	// 护栏口径(规格 §4.1):阈值按 实测 × 1.4 定,正常不截、异常才截。
	// 留一组永不触发又读起来像在生效的数字,比不装这个插件更隐蔽。
	//
	// 真环境实测(query="上市公司大股东通过集中竞价减持股份,需要提前多久预披露?",
	// corpus_types=["external"],与 Task 15f 同一道已验证切题的问题):
	//   search_policy      8 条 / 2109 字符(qcfg.topk=8 封顶,agent 控制不了)
	//   get_clause_detail  8 个 id 一次取全 / 5491 字符
	//   enumerate_clauses  50 条 / 10638 字符(qcfg.enumerate_topk=50 封顶,同样是配置项而非
	//                       语料量;字符数远超 search_policy 量级 —— 若挂在 maxChars.default
	//                       下会导致它的正常输出被截断,所以单独给一个 maxChars.enumerate_clauses)
	//   search_cases       0 条(cases 表 0 行,恒零命中,无字符信号)
	// 阈值 = 实测 × 1.4,向上取整到百位。
	it("sets result-budget thresholds at the measured guardrail values", () => {
		const options = (
			spec.resultPolicy as {
				options: { maxHits: Record<string, number>; maxChars: Record<string, number> };
			}
		).options;
		expect(options.maxHits.search_policy).toBe(12);
		expect(options.maxHits.search_cases).toBe(12);
		expect(options.maxHits.enumerate_clauses).toBe(70);
		expect(options.maxChars.get_clause_detail).toBe(7700);
		expect(options.maxChars.enumerate_clauses).toBe(14900);
		expect(options.maxChars.default).toBe(3000);
	});

	it("forwards the selected sparse backend to the isolated MCP process", () => {
		const servers = spec.mcpServers as Array<{ id: string; env: Record<string, string> }>;
		const policyQuery = servers.find((server) => server.id === "policy-query");
		expect(policyQuery?.env.PIPELINE_SPARSE_BACKEND).toBe(`\${PIPELINE_SPARSE_BACKEND}`);
	});

	it("ships fastPath enabled by default", () => {
		const fastPath = spec.fastPath as { enabled?: boolean } | undefined;
		expect(fastPath?.enabled).toBe(true);
	});

	it("points fastPath at three prompt files that exist", async () => {
		const fastPath = spec.fastPath as Record<"systemPrompt" | "rewritePrompt" | "answerPrompt", string>;
		for (const key of ["systemPrompt", "rewritePrompt", "answerPrompt"] as const) {
			await expect(readFile(resolve(specDir, fastPath[key]), "utf8")).resolves.toBeTruthy();
		}
	});

	// deriveFastSpec 的注释(fast-path-runtime.ts)与 M-1 的裁定:`result-budget` 挂在 pi 的
	// `tool_result` hook 上做截断,而阶段 1 的检索全部经 `Assembled.callTool` 直打
	// `tool.execute()`,绕过 agent loop,该 hook 不会触发。`fastPath.maxChars` 因此是一份配了
	// 也不生效的配置——出厂 spec 不设它,防止未来有人照着 `resultPolicy.options.maxChars` 的
	// 样子给 fastPath 也填一份、造出一句看着在生效实则空转的谎。阶段 1 证据块大小唯一生效的
	// 护栏是 `maxClauses`。
	it("does not configure fastPath.maxChars — the result-budget hook never fires on the fast path's direct tool.execute() retrieval, so the key would be dead config", () => {
		const fastPath = spec.fastPath as { maxChars?: unknown } | undefined;
		expect(fastPath?.maxChars).toBeUndefined();
	});

	it("keeps the fast answer prompt carrying the output contract, not the system prompt", async () => {
		const fastPath = spec.fastPath as Record<"systemPrompt" | "answerPrompt", string>;
		const sys = await readFile(resolve(specDir, fastPath.systemPrompt), "utf8");
		const ans = await readFile(resolve(specDir, fastPath.answerPrompt), "utf8");
		expect(sys).not.toContain("finish_reason");
		expect(ans).toContain("finish_reason");
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
			expect(assembled.session.systemPrompt).toContain("的元素只能有上面列出的这九个键");
			expect(assembled.session.systemPrompt).not.toContain("policy-query/output-format.md");
		} finally {
			await cleanup();
		}
	});
});

// 2026-08-04 复审 I-2:文件级断言(下面 "keeps the fast answer prompt carrying the output
// contract..." 那条)只读 fast-system.md 的**文件内容**,断不到 skillPaths 传/不传对装配后的
// system prompt 有什么影响。这里直接调用 deriveFastSpec(生产代码本体,不是重新实现一遍派生
// 逻辑)+ assemble(),把断言下沉到**装配后**的 assembled.session.systemPrompt 上,锁的是
// "skillPaths 传/不传如何影响 assemble() 的产出"这条机制本身。
//
// **这条 describe 不锁什么**:两条用例都直接调 deriveFastSpec + assemble(),不经过
// createDefaultRuntimeFactory 里 buildFast()/createFastPathRuntime 那次真实调用(server/main.ts
// 232-256 行)——main.ts 那个调用点到底有没有真的省略 skillPaths,不在这条 describe 的覆盖范围
// 内:下面第一条用例"刻意不传 skillPaths"是测试自己选定的输入,不是从 main.ts 读出来的实际调用
// 参数;main.ts 那个调用点即便被人改成也传 skillPaths,这两条用例都不会跟着翻红。
//
// ⚠ 实测记录,不是凭空推断:第一条用例本想用"传 skillPaths vs 不传"做对照来证明断言有区分力,
// 但实测发现 pi 的 buildSystemPrompt(packages/coding-agent/src/core/system-prompt.ts:64-66)
// 有一道 assembler.ts 注释没提到的额外闸门 —— customPrompt 分支下,只有 selectedTools 包含
// "read" 时才会把 additionalSkillPaths 拼进 <available_skills>。policy-query 的 spec.tools
// 是固定的 5 个领域工具,两个阶段都从未包含 "read",于是"传不传 skillPaths"在出厂 spec 原样的
// tools 下**结果相同**——今天的系统提示里本来就不会出现 <available_skills>,不是靠不传
// skillPaths 才躲开的。第一条用例只断言"不传 skillPaths 时确实没有",不再声称这个断言有实测
// 区分力;第二条用例改用人为加了 "read" 的 tools 列表,实测复现"传 skillPaths 确实会把
// evidence-standard.md 描述里的 confidence 一词带进 system prompt"这个机制是真实存在的,以此
// 说明 main.ts 为什么仍然刻意不给阶段 1 传 skillPaths(阶段 1 本来就没有任何工具,传
// skillPaths 对它没有用处;而工具白名单一旦将来变化到包含 "read",同一处代码会从"无影响"
// 变成"真的泄漏")——不是假装这个症状在今天的出厂 spec 上就能观察到。
describe("阶段 1 装配后的 system prompt 不该带 skills 摘要(2026-08-04 复审 I-2)", () => {
	it("omitting skillPaths keeps the skills digest out of the assembled prompt", async () => {
		const runtimeSpec = freshRuntimeSpec();
		await resolveSpecPromptPaths(runtimeSpec, specDir);
		const derived = deriveFastSpec(runtimeSpec);

		const harness = await createFauxHarness();
		const assembled = await assemble({
			pluginContext: fauxPluginContext(),
			spec: derived,
			profile: fauxProfile,
			registry: createDefaultPluginRegistry(),
			toolsets: policyQueryToolsets(derived.tools),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			// 刻意不传 skillPaths —— main.ts 现在装配阶段 1 时也是这么做的(I-2)。
		});
		try {
			expect(assembled.session.systemPrompt).not.toContain("<available_skills>");
			expect(assembled.session.systemPrompt).not.toContain("confidence");
		} finally {
			await assembled.dispose();
			await harness.cleanup();
		}
	});

	it("demonstrates the skills→'confidence' leak mechanism with a synthetic 'read'-inclusive tool list — the reason stage 1 deliberately omits skillPaths, even though today's real whitelist never triggers it", async () => {
		const runtimeSpec = freshRuntimeSpec();
		await resolveSpecPromptPaths(runtimeSpec, specDir);
		const derived = deriveFastSpec(runtimeSpec);
		// 与 createDefaultRuntimeFactory 构造期算 skillPaths 的方式一致(server/main.ts):
		// spec.skills 相对 specsDir 解析成绝对路径。
		const resolvedSkillPaths = (runtimeSpec.skills ?? []).map((rel) => resolve(specDir, rel));
		expect(resolvedSkillPaths.length).toBeGreaterThan(0); // 前提:出厂 spec 真的声明了 skills
		// 人为加 "read"——policy-query 出厂 spec 今天不会这么配,这里只是撬开
		// customPromptHasRead 那道闸门,复现机制本身。
		const withReadTool = { ...derived, tools: [...derived.tools, "read"] };

		const harness = await createFauxHarness();
		const assembled = await assemble({
			pluginContext: fauxPluginContext(),
			spec: withReadTool,
			profile: fauxProfile,
			registry: createDefaultPluginRegistry(),
			toolsets: policyQueryToolsets(withReadTool.tools),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			skillPaths: resolvedSkillPaths, // 复现"仍然传 skillPaths"的写法
		});
		try {
			expect(assembled.session.systemPrompt).toContain("<available_skills>");
			expect(assembled.session.systemPrompt).toContain("confidence"); // evidence-standard.md 的 description
		} finally {
			await assembled.dispose();
			await harness.cleanup();
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
