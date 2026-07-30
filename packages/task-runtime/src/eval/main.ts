#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPrompt, loadPromptParts } from "./build-prompt.ts";
import { DEFAULT_CASE_IDS, loadFormalCases, selectCases } from "./cases.ts";
import { type CaseOutcome, judge, renderSummary, runCase } from "./drive.ts";

const TASK_TIMEOUT_MS = 900_000; // 对齐 eval_config.yaml 的 task_timeout_seconds: 900

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"eval-root": { type: "string" },
			out: { type: "string" },
			spec: { type: "string" },
			profile: { type: "string" },
			cases: { type: "string" },
			all: { type: "boolean" },
		},
	});
	for (const key of ["eval-root", "out"] as const) {
		if (!values[key]) throw new Error(`--${key} is required`);
	}
	const evalRoot = resolve(values["eval-root"] as string);
	const outDir = resolve(values.out as string);
	const specSource = resolve(values.spec ?? "packages/task-runtime/specs/blackbox-eval.json");
	const profilePath = resolve(values.profile ?? "packages/task-runtime/profiles/deepseek-cloud.json");

	await mkdir(outDir, { recursive: true });

	// spec 里的 mcpServers.args 存的是相对 eval-root 的片段(提交进版本库的文件不能带本机绝对路径),
	// 这里解析成绝对路径后写一份临时 spec 给 CLI。
	const spec = JSON.parse(await readFile(specSource, "utf8")) as {
		mcpServers?: Array<{ id: string; command: string; args: string[]; env: Record<string, string> }>;
	};
	for (const server of spec.mcpServers ?? []) {
		server.args = server.args.map((arg) => (arg.startsWith("/") ? arg : join(evalRoot, arg)));
	}
	const specPath = join(outDir, "spec.resolved.json");
	await writeFile(specPath, JSON.stringify(spec, null, 2));

	// 摘要措辞跟着实际调用方式走(见 drive.ts 的 CaseSelection):传了 --all 就是「15 题全集」,
	// 传了 --cases 就是「自定义」,两者都没传才是默认的 5 题子集。判断依据是「传了哪个 flag」,
	// 不是「结果凑巧等于哪个集合」——否则自定义参数刚好传出默认 5 题时,措辞会认错范围。
	const mode: "default" | "all" | "custom" = values.all ? "all" : values.cases ? "custom" : "default";
	const all = await loadFormalCases(evalRoot);
	const ids = values.all ? all.map((c) => c.id) : (values.cases?.split(",").map((s) => s.trim()) ?? DEFAULT_CASE_IDS);
	const cases = selectCases(all, ids);
	const parts = await loadPromptParts(evalRoot);

	// 串行:并发会同时起 2N 个 Python 子进程,而判据不要求并发(判据④已由 isolation.test.ts 覆盖)。
	const outcomes: CaseOutcome[] = [];
	for (const evalCase of cases) {
		process.stderr.write(`[eval] ${evalCase.id} …\n`);
		outcomes.push(
			await runCase({
				evalCase,
				prompt: buildPrompt(evalCase, "precise", parts),
				evalRoot,
				outDir,
				specPath,
				profilePath,
				timeoutMs: TASK_TIMEOUT_MS,
			}),
		);
	}

	const verdict = judge(outcomes);
	await writeFile(join(outDir, "summary.json"), `${JSON.stringify({ outcomes, verdict }, null, 2)}\n`);
	await writeFile(join(outDir, "summary.md"), renderSummary(outcomes, verdict, { mode }));
	process.stderr.write(
		`[eval] 判据① ${verdict.criterion1.pass ? "pass" : "FAIL"} / 判据② ${verdict.criterion2.pass ? "pass" : "FAIL"}\n`,
	);
	if (!verdict.criterion1.pass || !verdict.criterion2.pass) process.exitCode = 2;
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
