import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AUDIT_SERVICE_ENV, localAuditEnvironment } from "../server/local-services.ts";
import type { RuntimeFactory } from "../server/run-manager.ts";
import { createWorkerRuntime, type WorkerConfig } from "./runtime.ts";

/** Only named config references enter the worker environment, not the host's full env. */
export async function createWorkerFactory(
	config: WorkerConfig,
	env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeFactory> {
	env = localAuditEnvironment(env);
	const profile = JSON.parse(await readFile(config.profilePath, "utf8")) as { apiKeyEnv: string };
	const names = new Set([
		...AUDIT_SERVICE_ENV,
		"PATH",
		"HOME",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		profile.apiKeyEnv,
		"AUDIT_AI_BASE_URL",
		"AUDIT_AI_INTERNAL_TOKEN",
		"DFZQ_UPLOADS_BUCKET",
		"DFZQ_MINIO_ENDPOINT",
		"DFZQ_MINIO_PORT",
		"DFZQ_MINIO_USE_SSL",
		"DFZQ_MINIO_ACCESS_KEY",
		"DFZQ_MINIO_SECRET_KEY",
	]);
	const timeouts = new Map<string, number>();
	for (const name of (await readdir(config.specsDir)).filter((f) => f.endsWith(".json"))) {
		const text = await readFile(join(config.specsDir, name), "utf8");
		for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
		const spec = JSON.parse(text) as { id: string; limits?: { runTimeoutMs?: number } };
		if (spec.limits?.runTimeoutMs) timeouts.set(spec.id, spec.limits.runTimeoutMs);
	}
	const childEnv = Object.fromEntries(
		[...names].filter((name) => env[name] !== undefined).map((name) => [name, env[name] as string]),
	);
	const paths = {
		auditReportSources: config.auditReportSources,
		embedding: config.embedding,
		state: config.state?.kind === "sqlite" ? { ...config.state, path: resolve(config.state.path) } : config.state,
		profilePath: resolve(config.profilePath),
		specsDir: resolve(config.specsDir),
		workRoot: resolve(config.workRoot),
	};
	if (config.state?.kind === "postgres" && env[config.state.dsnEnv])
		childEnv[config.state.dsnEnv] = env[config.state.dsnEnv] as string;
	if (config.embedding?.apiKeyEnv && env[config.embedding.apiKeyEnv])
		childEnv[config.embedding.apiKeyEnv] = env[config.embedding.apiKeyEnv] as string;
	return (input) => createWorkerRuntime(paths, input, { env: childEnv, runTimeoutMs: timeouts.get(input.specId) });
}
