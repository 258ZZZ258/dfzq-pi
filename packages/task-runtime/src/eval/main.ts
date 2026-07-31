#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { McpServerSpec } from "../toolsets/mcp/adapter.ts";
import { buildPrompt, loadPromptParts } from "./build-prompt.ts";
import { DEFAULT_CASE_IDS, loadFormalCases, selectCases } from "./cases.ts";
import { discoverTools } from "./discover-tools.ts";
import { type CaseOutcome, judge, renderSummary, runCase } from "./drive.ts";
import { evaluateProbe, judgeProbes, PROBES, type ProbeOutcome, renderProbeSummary } from "./limits-probe.ts";
import { resolveMode } from "./mode.ts";

const TASK_TIMEOUT_MS = 900_000; // 对齐 eval_config.yaml 的 task_timeout_seconds: 900

interface EvalSpec {
	mcpServers?: McpServerSpec[];
	limits?: Record<string, number>;
	[key: string]: unknown;
}

interface RunProbesArgs {
	/** 已把 mcpServers.args 解析成绝对路径的基线 spec;探针只借用它的 tools/mcpServers,limits 会被整体替换。 */
	spec: EvalSpec;
	evalRoot: string;
	outDir: string;
	profilePath: string;
}

/**
 * 判据③:四类限额各触发一次且归类正确。
 *
 * 每个探针写一份独立临时 spec —— `limits` 字段用 probe.limits **整体替换**,不是合并进
 * 基线的 `{ maxTurns: 16, runTimeoutMs: 900000 }`。合并的话基线限额会跟探针限额一起生效,
 * 触发的可能是基线那一类而不是探针要测的那一类,判据③「归类正确」就失去意义。
 */
async function runProbes(args: RunProbesArgs): Promise<void> {
	const all = await loadFormalCases(args.evalRoot);
	const [probeCase] = selectCases(
		all,
		// PROBES 全部共用同一个 caseId(见 limits-probe.ts 的注释与测试断言),取第一个即可。
		[PROBES[0].caseId],
	);
	const parts = await loadPromptParts(args.evalRoot);
	const prompt = buildPrompt(probeCase, "precise", parts);
	const limitsDir = join(args.outDir, "limits");

	const outcomes: ProbeOutcome[] = [];
	for (const probe of PROBES) {
		process.stderr.write(`[eval] probe ${probe.id} (期望 ${probe.expect}) …\n`);
		const probeSpec: EvalSpec = { ...args.spec, limits: { ...probe.limits } };
		const probeSpecPath = join(limitsDir, `spec.${probe.id}.json`);
		await mkdir(limitsDir, { recursive: true });
		await writeFile(probeSpecPath, JSON.stringify(probeSpec, null, 2));

		const outcome = await runCase({
			evalCase: probeCase,
			prompt,
			evalRoot: args.evalRoot,
			// 每个探针的 caseId 都是 L3-001,必须分目录跑,否则后一个探针的 outcome.json /
			// trajectory 会覆盖前一个的。
			outDir: join(limitsDir, probe.id),
			specPath: probeSpecPath,
			profilePath: args.profilePath,
			timeoutMs: TASK_TIMEOUT_MS,
		});
		outcomes.push(evaluateProbe(probe, outcome.result?.status, outcome.result?.limit));
	}

	const verdict = judgeProbes(outcomes);
	await writeFile(join(limitsDir, "summary.json"), `${JSON.stringify({ outcomes, verdict }, null, 2)}\n`);
	await writeFile(join(limitsDir, "summary.md"), renderProbeSummary(outcomes));
	process.stderr.write(`[eval] 判据③ ${verdict.pass ? "pass" : "FAIL"} —— ${verdict.detail}\n`);
	if (!verdict.pass) process.exitCode = 2;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"eval-root": { type: "string" },
			out: { type: "string" },
			spec: { type: "string" },
			profile: { type: "string" },
			cases: { type: "string" },
			all: { type: "boolean" },
			discover: { type: "boolean" },
			probes: { type: "boolean" },
		},
	});
	// --discover 与 --probes 互斥(见 mode.ts):同传时直接报错退出,不能静默丢弃其中一个 ——
	// 那会让调用方只查 exit code 就误以为判据③已经跑过。
	const mode = resolveMode({ discover: values.discover, probes: values.probes });

	if (!values["eval-root"]) throw new Error("--eval-root is required");
	const evalRoot = resolve(values["eval-root"] as string);
	const specSource = resolve(values.spec ?? "packages/task-runtime/specs/blackbox-eval.json");
	const profilePath = resolve(values.profile ?? "packages/task-runtime/profiles/deepseek-cloud.json");

	// spec 里的 mcpServers.args 存的是相对 eval-root 的片段(提交进版本库的文件不能带本机绝对路径),
	// 这里解析成绝对路径后写一份临时 spec 给 CLI。--discover / --probes 也共用这份解析结果。
	const spec = JSON.parse(await readFile(specSource, "utf8")) as EvalSpec;
	for (const server of spec.mcpServers ?? []) {
		server.args = server.args.map((arg) => (arg.startsWith("/") ? arg : join(evalRoot, arg)));
	}

	if (mode === "discover") {
		// 只做 initialize + tools/list,不跑用例、不调模型 —— 换 fixture 时用来核对工具名单。
		const discovered = await discoverTools(spec.mcpServers ?? []);
		process.stdout.write(`${JSON.stringify(discovered, null, 2)}\n`);
		return;
	}

	if (!values.out) throw new Error("--out is required");
	const outDir = resolve(values.out as string);
	await mkdir(outDir, { recursive: true });

	if (mode === "probes") {
		await runProbes({ spec, evalRoot, outDir, profilePath });
		return;
	}

	const specPath = join(outDir, "spec.resolved.json");
	await writeFile(specPath, JSON.stringify(spec, null, 2));

	// 摘要措辞跟着实际调用方式走(见 drive.ts 的 CaseSelection):传了 --all 就是「15 题全集」,
	// 传了 --cases 就是「自定义」,两者都没传才是默认的 5 题子集。判断依据是「传了哪个 flag」,
	// 不是「结果凑巧等于哪个集合」——否则自定义参数刚好传出默认 5 题时,措辞会认错范围。
	// 命名为 selectionMode 而不是 mode,避免跟上面 resolveMode() 产出的 EvalMode 撞名 ——
	// 两者是完全不同的两层概念(前者是 discover/probes/batch 三选一,后者是批跑范围)。
	const selectionMode: "default" | "all" | "custom" = values.all ? "all" : values.cases ? "custom" : "default";
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
	await writeFile(join(outDir, "summary.md"), renderSummary(outcomes, verdict, { mode: selectionMode }));
	process.stderr.write(
		`[eval] 判据① ${verdict.criterion1.pass ? "pass" : "FAIL"} / 判据② ${verdict.criterion2.pass ? "pass" : "FAIL"}\n`,
	);
	if (!verdict.criterion1.pass || !verdict.criterion2.pass) process.exitCode = 2;
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
