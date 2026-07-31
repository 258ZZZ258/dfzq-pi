#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ProviderProfile } from "../env/provider-profile.ts";
import { attachTrajectory } from "../observability/trajectory.ts";
import { createDefaultPluginRegistry } from "../runtime/default-plugins.ts";
import { createSessionRuntime } from "../runtime/session-runtime.ts";
import type { RuntimeSpec } from "../spec/types.ts";
import { createMcpToolset, type McpServerSpec } from "../toolsets/mcp/adapter.ts";
import { ToolsetRegistry } from "../toolsets/registry.ts";
import { cleanupAfterRun } from "./cleanup.ts";

/** spec 文件在 RuntimeSpec 之外多带一个 mcpServers,用于把 toolset 落到具体进程。 */
interface SpecFile extends RuntimeSpec {
	mcpServers?: McpServerSpec[];
}

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			spec: { type: "string" },
			profile: { type: "string" },
			workdir: { type: "string" },
			input: { type: "string" },
			trajectory: { type: "string" },
			runId: { type: "string" },
		},
	});

	if (positionals[0] !== "run") {
		throw new Error("usage: task-runtime run --spec <file> --profile <file> --workdir <dir> --input <text>");
	}
	for (const key of ["spec", "profile", "workdir", "input"] as const) {
		if (!values[key]) throw new Error(`--${key} is required`);
	}

	const spec = JSON.parse(await readFile(values.spec as string, "utf8")) as SpecFile;
	const profile = JSON.parse(await readFile(values.profile as string, "utf8")) as ProviderProfile;
	const workdir = values.workdir as string;

	const toolsets = new ToolsetRegistry();
	toolsets.register(
		spec.toolset,
		createMcpToolset(
			(spec.mcpServers ?? []).map((server) => ({
				...server,
				// eval 模式:把每任务的工具调用日志路径传进 MCP server
				env: {
					...server.env,
					...(process.env.EVAL_TASK_LOG ? { EVAL_TASK_LOG: process.env.EVAL_TASK_LOG } : {}),
				},
			})),
		),
	);

	const runtime = await createSessionRuntime({
		spec,
		profile,
		registry: createDefaultPluginRegistry(),
		toolsets,
		cwd: join(workdir, "workspace"),
		agentDir: join(workdir, "agent"),
	});

	const detach = values.trajectory ? await attachTrajectory(runtime, values.trajectory) : undefined;
	try {
		const result = await runtime.run(values.input as string, { runId: values.runId });
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (result.status !== "completed") process.exitCode = 2;
	} finally {
		// 清理失败只记日志,不改退出码 —— 见 cleanup.ts 的说明。
		await cleanupAfterRun(detach, runtime);
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
