import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type { ProviderProfile } from "../env/provider-profile.ts";
import { loadSpecRouter } from "../router/router.ts";
import { createDefaultPluginRegistry } from "../runtime/default-plugins.ts";
import { createSessionRuntime } from "../runtime/session-runtime.ts";
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

	const app = createApp({ manager, router, store, internalToken: options.internalToken });
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

/**
 * `spec.systemPrompt` / `spec.appendSystemPrompt` 就地解析成实际正文——直接改写传入对象上的
 * 这两个字段,不返回新对象。
 *
 * **导出是为了可测试性**:test/policy-query-spec.test.ts 的"出厂 spec 的 prompt 路径真的会被
 * 解析"直接调用这个函数 + `assemble()` 组出一个真实 AgentSession 来断言
 * `assembled.session.systemPrompt`。这条断言够不到 `createDefaultRuntimeFactory` 返回的
 * `RuntimeFactory` ——那条路径经 `createSessionRuntime` 只交回 `contract.ts` 里的 `Runtime`,
 * 不暴露 `assemble()` 产出的 `Assembled.session`;而 policy-query 出厂 spec 的 `mcpServers`
 * 需要真实的 `${DFZQ_AUDIT_AI_PYTHON}` 解释器,也不该是这条单测的依赖。所以生产路径(下面
 * `createDefaultRuntimeFactory` 的构造期 for 循环)与测试喂的是同一份解析代码,不是测试自己
 * 另起一套影子实现——`resolveSpecPromptPaths` 的构造期 for 循环调用点被去掉的话,test 必须跟
 * 着翻红(见 task-15d-report.md 的变异检验记录)。
 *
 * **为什么要在构造期把文件读出来,而不是把解析出的绝对路径原样交给 pi**:pi 的
 * `resolvePromptInput`(packages/coding-agent/src/core/resource-loader.ts:53-67)是
 * `existsSync(input) ? readFileSync(input) : input`——路径读不到就把路径字符串本身当 prompt
 * 正文,不抛也不告警。task-runtime 如果只算出绝对路径丢给它,路径写错(比如曾经的
 * `"@specs/policy-query/system.md"` 前缀)不会在装配阶段暴露,而是让模型静默收到一串文件路径
 * 当系统提示——这正是 `spec.systemPrompt` 自 3dc0d28c 起从未生效过的根因
 * (`.superpowers/sdd/实施计划-制度查询验收/task-15d-brief.md`)。
 *
 * - `systemPrompt`:出厂 spec 里就是路径(`specs/policy-query.json` 的
 *   `"policy-query/system.md"`),没有任何字面文本用例依赖它——无条件当路径处理,读不到直接
 *   抛,错误信息带 spec id 与字段名,方便定位是哪个 spec、哪个字段写错了路径。
 * - `appendSystemPrompt`:既有语义是"每一项要么是字面文本、要么是文件路径"
 *   (`runtime/assembler.ts` 里 `appendSystemPrompt` 选项那段注释),`test/assembler.test.ts`
 *   有两条用例直接把字面文本(`"DFZQ-APPENDED-ONE"` 等)传给 `assemble()`——那两条用例直接
 *   构造 `RuntimeSpec` 传给 `assemble()`,根本不经过 `createDefaultRuntimeFactory` / 这个
 *   函数,不受影响;但这里如果对"`resolve(specsDir, item)` 不存在"的情况也抛错,会把 spec
 *   作者写字面文本这种合法用法堵死。所以判据是 `resolve(specsDir, item)` 是否存在:存在就读
 *   成正文,不存在就原样当字面文本继续传下去。
 */
export async function resolveSpecPromptPaths(spec: RuntimeSpec, specsDir: string): Promise<void> {
	if (spec.systemPrompt !== undefined) {
		const original = spec.systemPrompt;
		const abs = resolve(specsDir, original);
		try {
			spec.systemPrompt = await readFile(abs, "utf8");
		} catch (error) {
			throw new Error(
				`Spec "${spec.id}": systemPrompt "${original}" (resolved to "${abs}") could not be read — ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	if (spec.appendSystemPrompt?.length) {
		spec.appendSystemPrompt = await Promise.all(
			spec.appendSystemPrompt.map(async (item) => {
				const abs = resolve(specsDir, item);
				if (!existsSync(abs)) return item; // resolve() 落空 = 字面文本,原样传下去
				return await readFile(abs, "utf8");
			}),
		);
	}
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
		// 构造期把相对路径读成正文,读不到就响亮失败——见 resolveSpecPromptPaths 的注释。
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
	return async ({ specId, sessionId, runId, filters, options: runOptions }) => {
		const spec = specFiles.get(specId);
		if (!spec) throw new Error(`Spec "${specId}" is not registered`);

		const toolsets = new ToolsetRegistry();
		toolsets.register(
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

		const workdir = join(options.workRoot, sessionId);
		return createSessionRuntime({
			spec,
			profile,
			registry: plugins,
			toolsets,
			cwd: join(workdir, "workspace"),
			agentDir: join(workdir, "agent"),
			outputContractSchema: outputContractSchemas.get(specId),
			skillPaths: skillPaths.get(specId),
		});
	};
}
