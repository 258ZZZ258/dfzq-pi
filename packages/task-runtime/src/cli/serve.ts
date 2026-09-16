import { readFile } from "node:fs/promises";
import { createGrantVerifier, type GrantConfig } from "../auth/grant.ts";
import { SessionInbox } from "../interaction/inbox.ts";
import { createHttpEmbedder } from "../memory/embedding.ts";
import { MemoryService } from "../memory/service.ts";
import { createDocumentsClient } from "../runtime/policy-compare/documents-client.ts";
import { startServer } from "../server/main.ts";
import { CheckpointCoordinator } from "../state/checkpoints.ts";
import { configurationFingerprint } from "../state/config-fingerprint.ts";
import { withDurableExecution } from "../state/durable-factory.ts";
import { createPostgresStateStore } from "../state/postgres.ts";
import { createWorkerFactory } from "../worker/factory.ts";

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
	const databaseUrl = requireEnv(env, "PIPELINE_DB_DSN");
	const specsDir = requireEnv(env, "TASK_RUNTIME_SPECS_DIR");
	const profilePath = requireEnv(env, "TASK_RUNTIME_PROFILE");
	const workRoot = requireEnv(env, "TASK_RUNTIME_WORK_ROOT");
	const grants = createGrantVerifier(
		JSON.parse(await readFile(requireEnv(env, "TASK_RUNTIME_AUTH_CONFIG"), "utf8")) as GrantConfig,
	);
	const auditApiBaseUrl = env.AUDIT_REPORT_API_BASE_URL;
	const operatingWorkbookPath = env.AUDIT_REPORT_OPERATING_WORKBOOK;
	if ((auditApiBaseUrl === undefined) !== (operatingWorkbookPath === undefined)) {
		throw new Error("AUDIT_REPORT_API_BASE_URL and AUDIT_REPORT_OPERATING_WORKBOOK must be configured together");
	}

	const stateStore = createPostgresStateStore(databaseUrl);
	try {
		if (Boolean(env.TASK_RUNTIME_MEMORY_EMBEDDING_URL) !== Boolean(env.TASK_RUNTIME_MEMORY_EMBEDDING_MODEL))
			throw new Error("memory embedding URL and model must be configured together");
		const embedding =
			env.TASK_RUNTIME_MEMORY_EMBEDDING_URL && env.TASK_RUNTIME_MEMORY_EMBEDDING_MODEL
				? {
						baseUrl: env.TASK_RUNTIME_MEMORY_EMBEDDING_URL,
						model: env.TASK_RUNTIME_MEMORY_EMBEDDING_MODEL,
						apiKeyEnv: env.TASK_RUNTIME_MEMORY_EMBEDDING_KEY_ENV,
					}
				: undefined;
		const embedder = embedding
			? createHttpEmbedder({
					baseUrl: embedding.baseUrl,
					model: embedding.model,
					apiKey: embedding.apiKeyEnv ? requireEnv(env, embedding.apiKeyEnv) : undefined,
				})
			: undefined;
		const baseFactory = await createWorkerFactory(
			{
				profilePath,
				workRoot,
				specsDir,
				embedding,
				...(auditApiBaseUrl && operatingWorkbookPath
					? { auditReportSources: { apiBaseUrl: auditApiBaseUrl, operatingWorkbookPath } }
					: {}),
				state: { kind: "postgres", dsnEnv: "PIPELINE_DB_DSN" },
			},
			env,
		);
		const runtimeFactory = withDurableExecution(
			baseFactory,
			new CheckpointCoordinator(stateStore),
			await configurationFingerprint(profilePath, specsDir),
		);
		const auditBaseUrl = env.AUDIT_AI_BASE_URL;
		const auditToken = env.AUDIT_AI_INTERNAL_TOKEN;
		const server = await startServer({
			inbox: new SessionInbox(stateStore),
			grants,
			memory: new MemoryService(stateStore, { embedder }),
			port,
			databaseUrl,
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
		return {
			port: server.port,
			close: async () => {
				try {
					await server.close();
				} finally {
					await stateStore.close();
				}
			},
		};
	} catch (error) {
		await stateStore.close();
		throw error;
	}
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
