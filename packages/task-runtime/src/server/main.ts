import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type { ProviderProfile } from "../env/provider-profile.ts";
import { loadSpecRouter } from "../router/router.ts";
import { PluginRegistry } from "../runtime/plugin-registry.ts";
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
	const server = await new Promise<ServerType>((resolve) => {
		const instance = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" }, () => resolve(instance));
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;

	return {
		port,
		close: async () => {
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
	for (const name of (await readdir(options.specsDir)).filter((n) => n.endsWith(".json"))) {
		const parsed = JSON.parse(await readFile(join(options.specsDir, name), "utf8")) as SpecFile;
		specFiles.set(parsed.id, parsed);
	}

	return async ({ specId, sessionId }) => {
		const spec = specFiles.get(specId);
		if (!spec) throw new Error(`Spec "${specId}" is not registered`);

		// PluginRegistry 与 ToolsetRegistry 都**按 run 新建**。createSessionRuntime 把 limits
		// 描述符作为*实例*传给 assemble(),该描述符闭包捕获本次 run 的 LimitState 与 abort 句柄;
		// 复用同一个 registry 会撞 `Plugin "limits" is already registered`,并让并发 run 互相串
		// 状态(见 plugin-registry.ts / toolsets/registry.ts 的类注释)。
		const toolsets = new ToolsetRegistry();
		toolsets.register(spec.toolset, createMcpToolset(spec.mcpServers ?? []));

		const workdir = join(options.workRoot, sessionId);
		return createSessionRuntime({
			spec,
			profile,
			registry: new PluginRegistry(),
			toolsets,
			cwd: join(workdir, "workspace"),
			agentDir: join(workdir, "agent"),
		});
	};
}
