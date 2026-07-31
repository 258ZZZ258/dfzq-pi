#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

	if (positionals[0] === "serve") {
		// 动态 import:serve 分支会拉进 hono 与 node:sqlite,不该让单跑 CLI 也付这份启动开销。
		const { serveMain } = await import("./serve.ts");
		await serveMain(process.env);
		return;
	}

	if (positionals[0] !== "run") {
		throw new Error("usage: task-runtime run --spec <file> --profile <file> --workdir <dir> --input <text>");
	}
	for (const key of ["spec", "profile", "workdir", "input"] as const) {
		if (!values[key]) throw new Error(`--${key} is required`);
	}

	const spec = JSON.parse(await readFile(values.spec as string, "utf8")) as SpecFile;
	const profile = JSON.parse(await readFile(values.profile as string, "utf8")) as ProviderProfile;
	const workdir = values.workdir as string;

	// 审查 Important-2:此前这条 CLI 路径从不传 outputContractSchema —— eval/drive.ts 正是
	// spawn 这个文件跑评测,声明了 outputContract 的 spec 经这条路走会让 C6 悄悄不挂。
	// 与 server/main.ts 的 createDefaultRuntimeFactory 同一套逻辑:schema 路径相对 --spec
	// 指向的文件所在目录解析(与 OutputContractSpec.schema 的字段文档一致)。
	// ⚠️ eval/main.ts 会把 spec 重新落盘成 outDir 下的临时文件(spec.resolved.json)—— 如果
	// 未来某个 spec 声明了 outputContract 并经那条路径跑,schema 路径需要像 mcpServers.args
	// 那样提前解析成绝对路径再写进临时 spec,否则这里会去 outDir 里找一个不存在的文件。
	// 目前仓库里没有任何 spec 声明 outputContract,这条留给引入它的人。
	const outputContractSchema =
		spec.outputContract === undefined
			? undefined
			: JSON.parse(await readFile(resolve(dirname(values.spec as string), spec.outputContract.schema), "utf8"));

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
		outputContractSchema,
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
