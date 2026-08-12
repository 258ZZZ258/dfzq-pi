import { createDocumentsClient } from "../runtime/policy-compare/documents-client.ts";
import { createDefaultRuntimeFactory, startServer } from "../server/main.ts";

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	// 空串与未设置同等对待:`TASK_RUNTIME_INTERNAL_TOKEN=` 这种写法在 shell 里太容易
	// 出现,把它当"已配置"就是无鉴权上线。
	if (value === undefined || value === "") {
		throw new Error(`${name} is required (fail-closed: refusing to start without it)`);
	}
	return value;
}

function optionalNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
	}
	return parsed;
}

export async function runServe(env: NodeJS.ProcessEnv): Promise<{ port: number; close: () => Promise<void> }> {
	// token 先读:其余环境变量再齐全,没有它也不许起来。
	const internalToken = requireEnv(env, "TASK_RUNTIME_INTERNAL_TOKEN");
	const port = Number(requireEnv(env, "TASK_RUNTIME_PORT"));
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(
			`TASK_RUNTIME_PORT must be an integer in [0, 65535], got ${JSON.stringify(env.TASK_RUNTIME_PORT)}`,
		);
	}
	const dbPath = requireEnv(env, "TASK_RUNTIME_DB_PATH");
	const specsDir = requireEnv(env, "TASK_RUNTIME_SPECS_DIR");
	const profilePath = requireEnv(env, "TASK_RUNTIME_PROFILE");
	const workRoot = requireEnv(env, "TASK_RUNTIME_WORK_ROOT");

	const runtimeFactory = await createDefaultRuntimeFactory({ profilePath, workRoot, specsDir });
	const auditBaseUrl = env.AUDIT_AI_BASE_URL;
	const auditToken = env.AUDIT_AI_INTERNAL_TOKEN;
	return startServer({
		port,
		dbPath,
		specsDir,
		internalToken,
		runtimeFactory,
		documents:
			auditBaseUrl && auditToken
				? createDocumentsClient({ baseUrl: auditBaseUrl, internalToken: auditToken })
				: undefined,
		maxConcurrent: optionalNumber(env, "TASK_RUNTIME_MAX_CONCURRENT"),
		maxQueueDepth: optionalNumber(env, "TASK_RUNTIME_MAX_QUEUE_DEPTH"),
	});
}

/** CLI 分支用:起服务、报端口、接信号。 */
export async function serveMain(env: NodeJS.ProcessEnv): Promise<void> {
	const { port, close } = await runServe(env);
	console.error(`[task-runtime] listening on ${port}`);
	let closing = false;
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			if (closing) return;
			closing = true;
			// 优雅下线**不排空在途 run**(规格 B12,归 S3)。这里只响亮记一笔,
			// 让运维知道此刻被杀掉的 run 会在下次启动时被 recoverStaleRuns 标成 error。
			console.error(`[task-runtime] ${signal} received; closing listener WITHOUT draining in-flight runs`);
			void close().then(
				() => process.exit(0),
				(error: unknown) => {
					console.error("[task-runtime] close() failed", error);
					process.exit(1);
				},
			);
		});
	}
}
