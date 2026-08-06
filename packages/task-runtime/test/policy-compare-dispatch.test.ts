import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRuntimeFactory } from "../src/server/main.ts";

/**
 * Task 12 的核心接线:`spec.workflow === "policy-compare"` 真的让工厂走
 * `createPolicyCompareRuntime`,而不是静默落回 `createSessionRuntime`。
 *
 * 这里刻意不起真实 MCP 子进程(与 server-startup.test.ts 的 Minor-c / Critical-2 系列同一条
 * 纪律)——判据不是"assemble() 跑到底产出一个能用的 Runtime",而是"两条路径在装配早期就已经
 * 分岔到了不同的失败点",两条路径各自的**第一个**响亮失败点天然互斥、不需要真跑通六阶段:
 *   - policy-compare 分支:main.ts 在调用 createPolicyCompareRuntime() 之前先做
 *     `requireEnv("AUDIT_AI_BASE_URL")` 等 fail-closed 检查 —— SessionRuntime 路径永远不会
 *     提到这个 env 变量名,一旦错误信息里出现它,只可能是走了 policy-compare 分支。
 *   - SessionRuntime 分支:走 assemble() 的既有校验(validateSpec / tools 白名单交叉校验),
 *     错误信息不会提 AUDIT_AI_BASE_URL。
 */

function minimalProfile(): unknown {
	return {
		id: "p",
		baseUrl: "http://127.0.0.1:1",
		apiKeyEnv: "X",
		api: "openai-completions",
		roles: {
			main: {
				provider: "p",
				modelId: "m",
				contextWindow: 1000,
				maxTokens: 100,
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
	};
}

/** 制度比对工作流的 6 个必需 env(port/useSSL 是可选项,不在此列——见 main.ts 的 requireEnv 调用点)。 */
const REQUIRED_ENV_KEYS = [
	"AUDIT_AI_BASE_URL",
	"AUDIT_AI_INTERNAL_TOKEN",
	"DFZQ_UPLOADS_BUCKET",
	"DFZQ_MINIO_ENDPOINT",
	"DFZQ_MINIO_ACCESS_KEY",
	"DFZQ_MINIO_SECRET_KEY",
] as const;

let root: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-pc-dispatch-"));
	await mkdir(join(root, "specs"));
	// 测试进程可能是在已经配好这些 env 的机器上跑的(比如本地开发机)——先清空、每条用例
	// 自己按需要的组合设置,跑完再原样还原,不泄漏到同文件里的其它用例或其它测试文件。
	savedEnv = {};
	for (const key of REQUIRED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	for (const key of REQUIRED_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

async function writeSpec(name: string, spec: Record<string, unknown>): Promise<void> {
	await writeFile(join(root, "specs", `${name}.json`), JSON.stringify(spec));
}

async function buildFactory() {
	const profilePath = join(root, "profile.json");
	await writeFile(profilePath, JSON.stringify(minimalProfile()));
	return createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir: join(root, "specs") });
}

function pcSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "pc",
		model: { role: "main" },
		toolset: "t",
		tools: ["x"],
		limits: { maxTurns: 3 },
		workflow: "policy-compare",
		...overrides,
	};
}

function invoke(factory: Awaited<ReturnType<typeof buildFactory>>, specId: string) {
	return factory({
		specId,
		sessionId: "s1",
		runId: "r1",
		filters: { corpusTypes: ["internal"] },
		options: {},
	});
}

describe("createDefaultRuntimeFactory — workflow 分派真的生效(Task 12)", () => {
	it("workflow: policy-compare 走的是 createPolicyCompareRuntime 的构造路径,不是 SessionRuntime", async () => {
		await writeSpec("pc", pcSpec());
		const factory = await buildFactory();
		// 6 个必需 env 全空(beforeEach 已清空),第一个被读到的是 AUDIT_AI_BASE_URL——
		// 这个错误信息只可能来自 policy-compare 分支,SessionRuntime 从不读这个变量。
		await expect(invoke(factory, "pc")).rejects.toThrow(/AUDIT_AI_BASE_URL/);
	});

	it("对照组:同一份 spec 不声明 workflow ⇒ 走 SessionRuntime,报错来自 tools 白名单交叉校验,不提 AUDIT_AI_BASE_URL", async () => {
		const { workflow: _drop, ...withoutWorkflow } = pcSpec({ id: "sr" });
		await writeSpec("sr", withoutWorkflow);
		const factory = await buildFactory();
		// SessionRuntime 路径会先跑到 assemble() 里的 resolveModel(),需要 minimalProfile()
		// 的 apiKeyEnv("X")指向的 env 存在,才能继续往后走到本用例真正要断言的 tools 白名单
		// 交叉校验——否则会先在更早的模型解析步骤上失败,测不出想测的这一步。
		process.env.X = "fake-key";
		try {
			const error = await invoke(factory, "sr").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/tools whitelist references unknown tool/);
			expect((error as Error).message).not.toMatch(/AUDIT_AI_BASE_URL/);
		} finally {
			delete process.env.X;
		}
	});

	// 变异测试②的钉子:main.ts 的分派条件若从 `spec.workflow === "policy-compare"` 误写成
	// `spec.workflow !== undefined`,这条会翻红。
	//
	// "bogus" 是一个**从未经过 validateSpec** 就直接落在 spec 文件里的非法值——
	// createDefaultRuntimeFactory() 的构造期 for 循环只做 resolveSpecPromptPaths 之类的路径解析,
	// 不调 validateSpec(那一步只在 assemble() 内部发生,即工厂函数真的被调用、真的走到某一条
	// runtime 构造路径之后)。所以这条用例真正测的是"分派条件本身",不是"validateSpec 挡住了坏
	// 值"(那条已经由 policy-compare-spec.test.ts 的"未知的 workflow 取值被 validateSpec 拒绝"
	// 单独锁住)：
	//   - 正确条件(=== "policy-compare"):"bogus" 不匹配 ⇒ 落到 SessionRuntime ⇒ assemble()
	//     里的 validateSpec 抛 "unknown workflow \"bogus\""(错误信息含 "workflow")。
	//   - 误写成 `!== undefined`:"bogus" 满足 ⇒ 落到 policy-compare 分支 ⇒ 在到达 assemble()/
	//     validateSpec 之前先撞 requireEnv("AUDIT_AI_BASE_URL")(main.ts 里这一步在
	//     createPolicyCompareRuntime() 调用之前),报错文案完全不提 "workflow"。
	it("未知 workflow 值走 SessionRuntime 被 validateSpec 响亮拒绝,不会被分派条件误判成 policy-compare", async () => {
		await writeSpec("bogus", pcSpec({ id: "bogus", workflow: "bogus" }));
		const factory = await buildFactory();
		await expect(invoke(factory, "bogus")).rejects.toThrow(/workflow/);
	});
});

describe("createDefaultRuntimeFactory — policy-compare 工作流的必需 env,缺一即 fail-closed", () => {
	for (const key of REQUIRED_ENV_KEYS) {
		it(`缺 ${key} 时拒绝启动,不静默继续`, async () => {
			await writeSpec("pc", pcSpec());
			const factory = await buildFactory();
			// 除 key 之外全部填上假值——只测一个变量测不出"漏了别的变量检查"这种问题
			// (brief 明确点名的坑),必须每条用例把其余变量填满,只留目标变量缺失。
			for (const other of REQUIRED_ENV_KEYS) {
				if (other !== key) process.env[other] = "test-value";
			}
			await expect(invoke(factory, "pc")).rejects.toThrow(new RegExp(key));
		});
	}

	it("6 个 env 全部配好后,requireEnv 阶段不再拦截(错误来自更深处的真实装配,而不是 fail-closed 检查)", async () => {
		await writeSpec("pc", pcSpec());
		const factory = await buildFactory();
		for (const key of REQUIRED_ENV_KEYS) process.env[key] = "test-value";
		const error = await invoke(factory, "pc").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		for (const key of REQUIRED_ENV_KEYS) {
			expect((error as Error).message).not.toMatch(new RegExp(key));
		}
	});
});
