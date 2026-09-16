import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandEnvRefs, type McpServerSpec } from "../toolsets/mcp/adapter.ts";

export const AUDIT_SERVICE_ENV = [
	"PIPELINE_DB_DSN",
	"PIPELINE_MILVUS_HOST",
	"PIPELINE_EMBEDDING_MODE",
	"PIPELINE_EMBEDDING_MODEL",
	"PIPELINE_EMBEDDING_BASE_URL",
	"PIPELINE_EMBEDDING_API_KEY",
	"PIPELINE_EMBEDDING_ENDPOINT_MODEL",
	"PIPELINE_SPARSE_BACKEND",
	"PIPELINE_OBJECT_STORE_BACKEND",
	"MINIO_ENDPOINT",
	"MINIO_BUCKET",
	"MINIO_SECURE",
	"AUDIT_AI_TENANT_ID",
	"HF_HOME",
	"HF_HUB_OFFLINE",
	"MINERU_MODEL_SOURCE",
	"MINIO_ACCESS_KEY",
	"MINIO_SECRET_KEY",
	"QUERY_CONFIG_DIR",
	"QUERY_LLM_BACKEND",
	"QUERY_RERANK_BACKEND",
	"QUERY_RERANK_MODEL",
	"QUERY_RERANK_BASE_URL",
	"QUERY_RERANK_API_KEY",
	"QUERY_RERANK_PATH",
	"QUERY_RERANK_MIN_SCORE",
	"OPENAI_MODEL",
	"OPENAI_BASE_URL",
	"OPENAI_API_KEY",
	"OPENAI_REVIEW_MODEL",
	"QUERY_REVIEW_MODEL",
	"QUERY_MERGE_CONTEXT",
	"QUERY_MERGE_MODEL",
	"QUERY_HYDE",
	"QUERY_HYDE_MODEL",
	"QUERY_DECOMPOSE",
	"QUERY_DECOMPOSE_MODEL",
	"QUERY_BATCH_RETRIEVE_CONCURRENCY",
	"QUERY_OBSERVE",
	"QUERY_DOCNUM_BOOST",
	"QUERY_SCENARIO_EXPAND",
	"QUERY_SCENARIO_TERMS_PATH",
	"QUERY_SUMMARY_LLM",
	"QUERY_SUMMARY_MODEL",
] as const;

export function localAuditEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const root = env.DFZQ_AUDIT_AI_ROOT ?? fileURLToPath(new URL("../../../../services/audit-ai/", import.meta.url));
	return {
		...env,
		DFZQ_AUDIT_AI_ROOT: resolve(root),
		DFZQ_AUDIT_AI_PYTHON:
			env.DFZQ_AUDIT_AI_PYTHON ??
			join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
		PIPELINE_CONFIG_DIR: env.PIPELINE_CONFIG_DIR ?? join(root, "config"),
		POLICY_MCP_AUDIT_LOG:
			env.POLICY_MCP_AUDIT_LOG ??
			join(
				env.TASK_RUNTIME_WORK_ROOT ?? fileURLToPath(new URL("../../../../.runtime/", import.meta.url)),
				"policy-mcp.jsonl",
			),
	};
}

export function localAuditServers(servers: McpServerSpec[], env: NodeJS.ProcessEnv = process.env): McpServerSpec[] {
	const configured = localAuditEnvironment(env);
	return servers.map((server) => {
		const local = server.args[0] === "-m" && server.args[1] === "query.mcp.server";
		if (!local) return expandEnvRefs(server, configured);
		const inherited = Object.fromEntries(
			AUDIT_SERVICE_ENV.filter((key) => configured[key] !== undefined).map((key) => [key, configured[key]!]),
		);
		return expandEnvRefs(
			{
				...server,
				args: [join(configured.DFZQ_AUDIT_AI_ROOT!, "service.py"), "mcp", ...server.args.slice(2)],
				env: { ...inherited, ...server.env },
			},
			configured,
		);
	});
}
