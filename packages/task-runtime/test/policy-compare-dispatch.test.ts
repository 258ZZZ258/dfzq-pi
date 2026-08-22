import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as policyCompareRuntimeModule from "../src/runtime/policy-compare/runtime.ts";
import { createDefaultRuntimeFactory } from "../src/server/main.ts";
import type { RunOptions } from "../src/server/run-manager.ts";

/**
 * `RunOptions`(server/run-manager.ts)刻意不收窄,不含 `batchSize`(main.ts 的注释、
 * 该接口自己的注释都写了同一条理由)——HTTP 层的 `options` 本来就是宽松的
 * `Record<string, unknown>`,`batchSize` 是 policy-compare 工作流私有的读取约定,不是
 * `RunOptions` 的一部分。测试里要构造带 `batchSize` 的 `options` 传给工厂,只能在这个边界
 * 上转型——与 app.ts 的 `body.options as RunOptions | undefined` 同一条纪律,不是权宜之计。
 */
function optionsWithBatchSize(batchSize: unknown): RunOptions {
	return { batchSize } as unknown as RunOptions;
}

/**
 * Task 12 的核心接线:`spec.workflow === "policy-compare"` 真的让工厂走
 * `createPolicyCompareRuntime`,而不是静默落回 `createSessionRuntime`。
 *
 * 这里刻意不起真实 MCP 子进程(与 server-startup.test.ts 的 Minor-c / Critical-2 系列同一条
 * 纪律)——判据不是"assemble() 跑到底产出一个能用的 Runtime",而是"两条路径在装配早期就已经
 * 分岔到了不同的失败点",两条路径各自的**第一个**响亮失败点天然互斥、不需要真跑通六阶段:
 *   - policy-compare 分支:main.ts 在调用 createPolicyCompareRuntime() 之前先做
 *     `requireEnv("AUDIT_AI_BASE_URL")` 等必需的 audit-ai 连接检查 —— SessionRuntime 路径永远不会
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

/** 所有制度比对请求都必须具备的 audit-ai 连接环境变量。
 * MinIO 只服务上传件，知识库选文档不应因其未配置而被阻塞，故不在此列。 */
const REQUIRED_ENV_KEYS = ["AUDIT_AI_BASE_URL", "AUDIT_AI_INTERNAL_TOKEN"] as const;

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

describe("createDefaultRuntimeFactory — policy-compare 工作流的 audit-ai 必需 env,缺一即 fail-closed", () => {
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

	it("audit-ai 连接 env 全部配好后，知识库场景不再被 MinIO 配置预先拦截", async () => {
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

/**
 * Task 12 复审 Finding 1/2:`options.batchSize` 是唯一一处有分支逻辑的透传(env / payload /
 * skillPaths 都是无分支的原样传递),此前完全没有测试走过它的数字分支——评审把它硬编码成
 * `batchSize: undefined` 跑 `policy-compare-spec` + `policy-compare-dispatch` 两个文件是
 * 17/17 全绿,证明当时的用例(`invoke()` 一律传 `options: {}`)测不出这条线被切断。
 *
 * 用 `vi.spyOn` 直接接管 `createPolicyCompareRuntime`(而不是像上面几条那样靠"哪条错误信息
 * 先冒出来"这种间接判据)——`main.ts` 与本文件都从同一个相对路径
 * `src/runtime/policy-compare/runtime.ts` 导入,Vitest 的 ESM 转换让这里的 spy 对 main.ts
 * 内部已经 import 过的绑定同样生效(与 server-startup.test.ts 对 `sqliteModule` 的用法同一条
 * 已验证过的机制)。直接断言 spy 收到的 `batchSize` 参数值,不是去猜某条错误信息里有没有提到
 * 这个数字。
 */
describe("createDefaultRuntimeFactory — options.batchSize 到 createPolicyCompareRuntime 的透传(Task 12 复审 Finding 1)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("options.batchSize 是数字时,原样透传给 createPolicyCompareRuntime", async () => {
		await writeSpec("pc", pcSpec());
		const factory = await buildFactory();
		for (const key of REQUIRED_ENV_KEYS) process.env[key] = "test-value";

		let received: unknown = "createPolicyCompareRuntime 从未被调用";
		vi.spyOn(policyCompareRuntimeModule, "createPolicyCompareRuntime").mockImplementation(async (opts) => {
			received = opts.batchSize;
			return {} as unknown as Awaited<ReturnType<typeof policyCompareRuntimeModule.createPolicyCompareRuntime>>;
		});

		await factory({
			specId: "pc",
			sessionId: "s1",
			runId: "r1",
			filters: { corpusTypes: ["internal"] },
			options: optionsWithBatchSize(3),
		});
		expect(received).toBe(3);
	});

	it("options 不传 batchSize → createPolicyCompareRuntime 收到 undefined(走它自己的 DEFAULT_BATCH_SIZE),这一层不抛错", async () => {
		await writeSpec("pc", pcSpec());
		const factory = await buildFactory();
		for (const key of REQUIRED_ENV_KEYS) process.env[key] = "test-value";

		let received: unknown = "createPolicyCompareRuntime 从未被调用";
		vi.spyOn(policyCompareRuntimeModule, "createPolicyCompareRuntime").mockImplementation(async (opts) => {
			received = opts.batchSize;
			return {} as unknown as Awaited<ReturnType<typeof policyCompareRuntimeModule.createPolicyCompareRuntime>>;
		});

		await factory({
			specId: "pc",
			sessionId: "s1",
			runId: "r1",
			filters: { corpusTypes: ["internal"] },
			options: {},
		});
		expect(received).toBeUndefined();
	});

	it("options.batchSize 不是数字时响亮拒绝,错误信息带上实际收到的值 —— 不悄悄落回默认值", async () => {
		await writeSpec("pc", pcSpec());
		const factory = await buildFactory();
		// parseBatchSizeOption 在 6 个 requireEnv 检查之前就跑(main.ts 里的求值顺序),
		// 不需要配置任何 env 就能触发——这条本身也顺带证明了它排在最前面。
		const error = await factory({
			specId: "pc",
			sessionId: "s1",
			runId: "r1",
			filters: { corpusTypes: ["internal"] },
			options: optionsWithBatchSize("3"),
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("options.batchSize");
		expect((error as Error).message).toContain(JSON.stringify("3"));
	});
});
