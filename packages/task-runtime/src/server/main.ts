import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type { ProviderProfile } from "../env/provider-profile.ts";
import { loadSpecRouter } from "../router/router.ts";
import { createDefaultPluginRegistry } from "../runtime/default-plugins.ts";
import { createEscalatingRuntime } from "../runtime/escalating-runtime.ts";
import { createFastPathRuntime } from "../runtime/fast-path-runtime.ts";
import { createArtifactStore, createMinioObjectGetter } from "../runtime/policy-compare/artifact-store.ts";
import type { DocumentsClient } from "../runtime/policy-compare/documents-client.ts";
import { createDocumentsClient } from "../runtime/policy-compare/documents-client.ts";
import { createPolicyCompareRuntime } from "../runtime/policy-compare/runtime.ts";
import { createVersionDiffRuntime } from "../runtime/policy-compare/version-diff-runtime.ts";
import { createSessionRuntime } from "../runtime/session-runtime.ts";
import { resolveSpecPromptPaths } from "../spec/resolve-prompt-paths.ts";
import type { RuntimeSpec } from "../spec/types.ts";
import { createSqliteRunStore } from "../store/sqlite.ts";
import { createMcpToolset, type McpServerSpec } from "../toolsets/mcp/adapter.ts";
import { ToolsetRegistry } from "../toolsets/registry.ts";
import { createApp } from "./app.ts";
import { Gate } from "./gate.ts";
import type { RuntimeFactory } from "./run-manager.ts";
import { RunManager } from "./run-manager.ts";

export interface ServeOptions {
	port: number;
	dbPath: string;
	specsDir: string;
	internalToken: string | undefined;
	// 必填注入点(不是可选):真实装配要么起 MCP 子进程要么要真实模型,两者都超出 S1a
	// 判据。做成必填参数后 startServer 就是纯接线,可以用 stub 完整测试;真实工厂由
	// 下面单独导出的 createDefaultRuntimeFactory 提供。
	runtimeFactory: RuntimeFactory;
	maxConcurrent?: number;
	maxQueueDepth?: number;
	documents?: DocumentsClient;
}

export async function startServer(options: ServeOptions): Promise<{ port: number; close: () => Promise<void> }> {
	const store = createSqliteRunStore(options.dbPath);
	// 必须在开始接请求之前跑:否则 Java 会永远等一个不会完成的 run(设计文档 §5.7)。
	const recovered = store.recoverStaleRuns(Date.now());
	if (recovered > 0) {
		console.error(`[task-runtime] startup recovery marked ${recovered} stale run(s) as error`);
	}

	const router = await loadSpecRouter(options.specsDir);
	const gate = new Gate({ maxConcurrent: options.maxConcurrent, maxQueueDepth: options.maxQueueDepth });
	const manager = new RunManager({ store, gate, runtimeFactory: options.runtimeFactory });

	const app = createApp({
		manager,
		router,
		store,
		internalToken: options.internalToken,
		documents: options.documents,
	});
	// `server.listen()`(hono 内部调用)是异步绑定的:serve() 同步返回时,底层 socket
	// 大概率还没 bind 完成 —— 此刻 server.address() 恒为 null,若不等 "listening" 就
	// 返回,close() 在真正开始监听前被调用会直接抛 ERR_SERVER_NOT_RUNNING(而不是把
	// 监听端口干净地关掉),且 port:0 场景下调用方也拿不到真实分配到的端口。
	// listeningListener 的第二个参数就是为此设计的回调,这里用它把 serve() 的"同步返回
	// 但异步绑定"语义,转成本函数对外承诺的"resolve 时已确定监听"语义。
	//
	// "listening" 不是唯一可能触发的事件 —— 端口被占用(EADDRINUSE)等 bind 失败会触发
	// "error" 而不是 "listening"。listeningListener 只挂在 "listening" 上,若不单独接管
	// "error",bind 失败时这个 Promise 永远不 resolve 也不 reject:Node 对没有监听者的
	// server "error" 事件的默认语义是直接扔出去炸进程(EventEmitter 的 unhandled 'error'
	// 规则),就算调用方装了全局 uncaughtException 兜底吞掉了它,startServer() 也会
	// 永久挂起 —— "服务启不来"却不给调用方任何可 catch 的信号,比崩溃更难查。
	// 因此这里必须显式监听一次性的 "error" 并转成 reject;成功监听后要把它摘掉,否则
	// 装配完成后的真实运行期错误(比如极端情况下的 EMFILE)会被这个已经 settle 过的
	// listener 悄悄吃掉,而不是回退到 Node 默认的"响亮崩溃"行为。
	let server: ServerType;
	try {
		server = await new Promise<ServerType>((resolve, reject) => {
			let instance!: ServerType;
			const onError = (error: unknown) => {
				instance.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				instance.off("error", onError);
				resolve(instance);
			};
			instance = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" }, onListening);
			instance.once("error", onError);
		});
	} catch (error) {
		// bind 失败(比如 EADDRINUSE):调用方拿到的是一个 reject 的 promise,不会拿到
		// close() 去关掉上面已经打开的 store 句柄 —— 必须在这里自己关,不能悄悄泄漏
		// (与 assembler.ts 装配失败时自己 dispose 已开 toolset 句柄同一条纪律)。
		//
		// 但 store.close() 自身也可能抛(仓库已三次立过「次生错误不得盖过原始错误」的规矩:
		// sqlite.ts 吞 ROLLBACK 次生异常、run-manager.ts catch markError 失败、
		// session-runtime.ts)。这里若不吞掉,会用一个面目全非的次生报错替换掉本该抛出的
		// error(比如 EADDRINUSE),让「端口被占用」变成一个毫不相关的 store 关闭失败。
		try {
			store.close();
		} catch (closeError) {
			console.error("[task-runtime] failed to close the store after a bind failure", closeError);
		}
		throw error;
	}
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;

	// close() 必须能安全重入,与 store.close()(见 store/sqlite.ts)同一条纪律 ——
	// 调用方(以及测试的 afterEach)可能在已经 close 过一次之后再 close 一次;不设防的话
	// 第二次调用会在 server 上撞 ERR_SERVER_NOT_RUNNING。
	let closed = false;
	return {
		port,
		close: async () => {
			if (closed) return;
			closed = true;
			// 优雅下线(非重启)时仍有在途 run:没有排空协议(不在 S1a 判据内,见 brief),
			// 这些 run 会随进程一起消失。默认行为是完全静默 —— 调用方看到的只是 close()
			// resolve 了,run 的结果再也不会出现,直到下次启动 recoverStaleRuns() 才会把
			// 它们标成 error。把这一步变响亮,好让运维在日志里能看到"为什么"。
			if (manager.activeRuns > 0) {
				console.error(
					`[task-runtime] closing with ${manager.activeRuns} run(s) still in flight; their results will be ` +
						"lost and the rows will be marked as error by recoverStaleRuns() on next startup",
				);
			}
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			store.close();
		},
	};
}

export interface DefaultFactoryOptions {
	/** ProviderProfile 的 JSON 路径。 */
	profilePath: string;
	/** 每个 session 的工作目录根。 */
	workRoot: string;
	/**
	 * spec 文件目录。这里**不收 SpecRouter** —— 它只持有 RuntimeSpec,而装配还需要
	 * RuntimeSpec 之外的 mcpServers 字段,所以本工厂必须自己重读文件。收一个用不到的
	 * router 只会是死参数。
	 */
	specsDir: string;
}

/** spec 文件在 RuntimeSpec 之外多带一个 mcpServers,与 cli/main.ts 的 SpecFile 同一形状。 */
interface SpecFile extends RuntimeSpec {
	mcpServers?: McpServerSpec[];
}

export async function createDefaultRuntimeFactory(options: DefaultFactoryOptions): Promise<RuntimeFactory> {
	const profile = JSON.parse(await readFile(options.profilePath, "utf8")) as ProviderProfile;
	// spec 文件重读一次:SpecRouter 只持有 RuntimeSpec,mcpServers 不在该类型上。
	const specFiles = new Map<string, SpecFile>();
	// C6(输出契约判官)需要的 schema 文件:与 profile / spec 同一条纪律,构造期读一次、
	// 跨 run 复用,不放进下面返回的工厂函数体内每次 run 重读重 parse。
	// 审查 Minor-c:挪到这里之前,schema 文件缺失/损坏要拖到第一次真实请求才暴露,
	// 而且失败信息 obscure(typebox 在 Value.Check 里报 "Cannot use 'in' operator to
	// search for 'type' in null" 这类无法一眼看出病因的错误)。挪到构造期后,坏 schema
	// 在 startServer() 装配阶段就响亮失败,不必等到请求进来。
	const outputContractSchemas = new Map<string, unknown>();
	// spec.skills 与 outputContract.schema 同一条纪律:相对路径的基准是 spec 目录,
	// 而 assemble() 不知道 spec 从哪来 —— 解析归这里,构造期做一次、跨 run 复用。
	const skillPaths = new Map<string, string[]>();
	for (const name of (await readdir(options.specsDir)).filter((n) => n.endsWith(".json"))) {
		const parsed = JSON.parse(await readFile(join(options.specsDir, name), "utf8")) as SpecFile;
		// systemPrompt / appendSystemPrompt 与 skills / outputContract.schema 同一条纪律:
		// 构造期把相对路径读成正文,读不到就响亮失败——见 resolveSpecPromptPaths(现在是
		// ../spec/resolve-prompt-paths.ts 的独立模块)的注释。这行调用被去掉的话,
		// test/server-startup.test.ts 里
		// "createDefaultRuntimeFactory - systemPrompt / appendSystemPrompt resolution" 那个
		// describe 的第一条("fails at construction time when systemPrompt cannot be read")
		// 会翻红——已实测验证(见 task-15d-report.md 的 Critical-1 变异检验记录),不是没验过
		// 的覆盖率承诺。
		await resolveSpecPromptPaths(parsed, options.specsDir);
		specFiles.set(parsed.id, parsed);
		if (parsed.skills?.length) {
			skillPaths.set(
				parsed.id,
				parsed.skills.map((rel) => resolve(options.specsDir, rel)),
			);
		}
		if (parsed.outputContract !== undefined) {
			outputContractSchemas.set(
				parsed.id,
				JSON.parse(await readFile(resolve(options.specsDir, parsed.outputContract.schema), "utf8")),
			);
		}
	}

	// ToolsetRegistry **必须**按 run 新建(见 toolsets/registry.ts 的类注释):
	// 下面的 register(spec.toolset, ...) 每次 run 都会调一次,复用同一实例会撞
	// `Toolset "X" is already registered`。PluginRegistry 相反 —— 它是进程级的,
	// 所以在本工厂外面建一次、跨 run 复用。
	const plugins = createDefaultPluginRegistry();

	// ⚠ run 的 options 必须改名:外层 `options` 是 DefaultFactoryOptions(含 workRoot),
	// 同名解构会把它遮蔽掉,下面的 join(options.workRoot, ...) 会解析到错的目录。
	return async ({ specId, sessionId, runId, filters, options: runOptions, payload }) => {
		const spec = specFiles.get(specId);
		if (!spec) throw new Error(`Spec "${specId}" is not registered`);

		// 🔴 每次调用都新建一个 ToolsetRegistry。ToolsetRegistry **必须按 run 新建**
		// (toolsets/registry.ts 的类注释)。两阶段各调一次这个闭包 —— 不共用 MCP 会话正是
		// 规格 D-5。⚠ 会炸的不是"把同一个 registry 实例传给两个 runtime"本身(`register` 只
		// 调一次、`assemble()` 只调 `resolve()`,`createMcpToolset` 的 provider 每次
		// `resolve()` 都重新 spawn 一整套子进程,registry 自己不追踪句柄,复用同一实例反而
		// 无害);真正会炸的是**这个闭包自己**如果被改成复用同一个 registry 实例、却仍然在
		// 每次调用里执行 `register(...)`——那样第二次调用会在一个已经登记过 `spec.toolset`
		// 的实例上再登记一次,直接抛 `Toolset "policy-query" is already registered`。
		const buildToolsets = (): ToolsetRegistry => {
			const registry = new ToolsetRegistry();
			registry.register(
				spec.toolset,
				createMcpToolset(spec.mcpServers ?? [], {
					runId,
					// 默认值在**消费端**给,不在存档层(见 Task 4:filters_json 必须原样存档)。
					// 空数组 = 无额外限制,是边界契约明文非 fail-open(routes_boundary.py:39-40)。
					permTags: filters.permTags ?? [],
					corpusTypes: filters.corpusTypes,
					options: { topK: runOptions.topK, includeSuperseded: runOptions.includeSuperseded },
				}),
			);
			return registry;
		};

		const workdir = join(options.workRoot, sessionId);

		// 🔴 分派顺序:`workflow` 排在 `fastPath` 之前。前者整条换掉 Runtime 实现(连
		// SessionRuntime 都不经过),后者是 SessionRuntime 内部把模型调用压成固定 2 次 ——
		// 外层的先判。两者同时声明已由 validateSpec 在装配期拒掉,这里不会同时命中。
		if (spec.workflow === "policy-version-diff") {
			// 版本差异由 audit-ai 在同一 logical_id 的两份已入库版本上精确对齐条款；
			// 不依赖 MinIO/MCP/模型，避免把确定性 diff 退化为 agent 推理。
			return createVersionDiffRuntime({
				spec,
				payload,
				documents: createDocumentsClient({
					baseUrl: requireEnv("AUDIT_AI_BASE_URL"),
					internalToken: requireEnv("AUDIT_AI_INTERNAL_TOKEN"),
				}),
				permissionTags: filters.permTags ?? [],
			});
		}

		if (spec.workflow === "policy-compare") {
			// 确定性工作流:模型不编排,工具由代码经 Assembled.callTool 发起。
			// 三个外部依赖走 env —— 凭证绝不入库,缺任何一个都在这里 fail-closed。
			// batchSize 不在 RunOptions 类型上(run-manager.ts 的注释:该接口刻意不收窄,
			// 加字段不该变成一次 HTTP 层改动)—— 与 app.ts 的 `body.options as RunOptions`
			// 同一条纪律,在读取处窄化,不去反过来给 RunOptions 加一个只有本工作流用得到的字段。
			// 存在但不是数字 → 响亮拒绝,不是悄悄落回默认值:与本工作流其余每一处 fail-loud
			// 姿态一致(env 缺失即拒绝启动、未知 workflow 取值即抛、payload.outputTypes 非全选
			// 即 422)。静默吞掉反而会掩盖 createPolicyCompareRuntime 自己对 batchSize 的
			// 1..MAX_BATCH_SIZE 整数校验——那道校验只在值到达之后才有意义。
			const rawBatchSize = parseBatchSizeOption((runOptions as { batchSize?: unknown }).batchSize);
			const baseUrl = requireEnv("AUDIT_AI_BASE_URL");
			const internalToken = requireEnv("AUDIT_AI_INTERNAL_TOKEN");
			const bucket = requireEnv("DFZQ_UPLOADS_BUCKET");
			return createPolicyCompareRuntime({
				spec,
				profile,
				registry: plugins,
				// speedup 分支把 toolset 创建重构成了工厂(快路径与升级路径各需一份独立实例,
				// 见 buildToolsets 上方注释)。本工作流一个 run 只装配一次,调一次即可。
				toolsets: buildToolsets(),
				cwd: join(workdir, "workspace"),
				agentDir: join(workdir, "agent"),
				outputContractSchema: outputContractSchemas.get(specId),
				payload,
				documents: createDocumentsClient({ baseUrl, internalToken }),
				permissionTags: filters.permTags ?? [],
				artifacts: createArtifactStore({
					bucket,
					get: createMinioObjectGetter({
						endPoint: requireEnv("DFZQ_MINIO_ENDPOINT"),
						port: process.env.DFZQ_MINIO_PORT ? Number(process.env.DFZQ_MINIO_PORT) : undefined,
						useSSL: process.env.DFZQ_MINIO_USE_SSL === "1",
						accessKey: requireEnv("DFZQ_MINIO_ACCESS_KEY"),
						secretKey: requireEnv("DFZQ_MINIO_SECRET_KEY"),
					}),
				}),
				batchSize: rawBatchSize,
				skillPaths: skillPaths.get(specId),
			});
		}

		const buildFull = () =>
			createSessionRuntime({
				spec,
				profile,
				registry: plugins,
				toolsets: buildToolsets(),
				cwd: join(workdir, "workspace"),
				agentDir: join(workdir, "agent"),
				outputContractSchema: outputContractSchemas.get(specId),
				skillPaths: skillPaths.get(specId),
			});

		if (!spec.fastPath?.enabled) return buildFull();

		const fast = await createFastPathRuntime({
			spec,
			profile,
			registry: plugins,
			toolsets: buildToolsets(),
			cwd: join(workdir, "fast", "workspace"),
			agentDir: join(workdir, "fast", "agent"),
			outputContractSchema: outputContractSchemas.get(specId),
			// 🔴 阶段 1 刻意不传 skillPaths(2026-08-04 复审 I-2,协调者裁定):deriveFastSpec
			// 没摘 spec.skills。pi 的 buildSystemPrompt(coding-agent/src/core/system-prompt.ts)
			// 只在 selectedTools 包含 "read" 时才会把 additionalSkillPaths 拼成
			// <available_skills> 常驻进 system prompt(这道闸门的实测复现见
			// test/policy-query-spec.test.ts 的 "demonstrates the skills→'confidence' leak
			// mechanism..." 用例)——
			// policy-query 的 spec.tools 是固定的 5 个领域工具,今天两个阶段都不含 "read",
			// 所以传不传 skillPaths 眼下不改变阶段 1 装配出的 system prompt。这里仍然不传,
			// 理由是防御性的,不是在堵一个正在发生的泄漏:阶段 1 执行了
			// `setActiveToolsByName([])`,模型没有任何工具,skillPaths 对它没有用处;而
			// evidence-standard.md 的 description 里本身就含 "confidence" 一词,一旦这个
			// taskKind 的工具白名单将来加入 "read"(或这套两阶段模式被复用到别的、真的会给
			// "read" 的 spec 上),同一处代码会立刻从"无影响"变成"confidence 真的泄漏进两次
			// 模型调用共用的 system prompt"——硬约束 5 要求的是输出契约措辞只能待在
			// answerPrompt 里,不能进两次调用共用的 system prompt。阶段 2(下面的
			// buildFull)照旧传 skillPaths,行为不变。
		});
		// createFull 惰性 —— 不升级就一次都不调,不起第二个 MCP 子进程。
		return createEscalatingRuntime({ fast, createFull: buildFull });
	};
}

/** env 缺失即抛。工作流的外部依赖没有「跑起来再说」的降级路径。 */
function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`环境变量 ${name} 未配置 —— 制度比对工作流拒绝启动(fail-closed)`);
	return value;
}

/**
 * `RunOptions.batchSize` 的窄化 + fail-loud 校验。缺省(`undefined`)放行,交给
 * `createPolicyCompareRuntime` 自己的默认值(`DEFAULT_BATCH_SIZE`);存在但不是数字就在这里
 * 响亮拒绝,不悄悄落回默认值——静默吞掉会掩盖下游对 batchSize 的 1..MAX_BATCH_SIZE 整数校验,
 * 那道校验只有在值真的到达之后才有意义。
 */
function parseBatchSizeOption(raw: unknown): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "number") {
		throw new Error(`options.batchSize 必须是数字(收到:${JSON.stringify(raw)})`);
	}
	return raw;
}
