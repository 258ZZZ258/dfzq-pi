import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ReconcileReport } from "../observability/reconcile.ts";
import { reconcile } from "../observability/reconcile.ts";
import type { RunResult } from "../runtime/contract.ts";
import type { EvalCase } from "./cases.ts";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli/main.ts", import.meta.url));

export interface CaseOutcome {
	caseId: string;
	result?: RunResult;
	reconcile?: ReconcileReport;
	cliExitCode: number;
	error?: string;
	elapsedMs: number;
}

export interface Verdict {
	criterion1: { pass: boolean; detail: string };
	criterion2: { pass: boolean; detail: string };
}

export function judge(outcomes: CaseOutcome[]): Verdict {
	const notCompleted = outcomes.filter((o) => o.result?.status !== "completed");
	const criterion1 = {
		pass: notCompleted.length === 0,
		detail:
			notCompleted.length === 0
				? `全部 ${outcomes.length} 题 status=completed`
				: notCompleted
						.map((o) => `${o.caseId}: ${o.result?.status ?? `no result (${o.error ?? "unknown"})`}`)
						.join("; "),
	};

	// schemaMismatch / vacuous 必须单独点名:前者是 pi 事件 schema 漂移(尺子坏了),
	// 后者是两侧全空(什么都没比)。都报成「两侧不一致」会把根因指错方向。
	const bad = outcomes.filter((o) => !o.reconcile?.ok);
	const criterion2 = {
		pass: bad.length === 0,
		detail:
			bad.length === 0
				? `全部 ${outcomes.length} 题 reconcile.ok`
				: bad
						.map((o) => {
							const r = o.reconcile;
							if (!r) return `${o.caseId}: 无 reconcile 报告`;
							const flags: string[] = [];
							if (r.schemaMismatch) flags.push("schemaMismatch(pi 事件 schema 漂移,尺子坏了)");
							if (r.vacuous) flags.push("vacuous(两侧全空,未比较任何东西)");
							if (r.orderMismatch) flags.push("orderMismatch");
							if (r.missingInMcp.length) flags.push(`missingInMcp=${r.missingInMcp.join(",")}`);
							if (r.missingInPi.length) flags.push(`missingInPi=${r.missingInPi.join(",")}`);
							return `${o.caseId}: ${flags.join(" / ") || "ok=false"}`;
						})
						.join("; "),
	};

	return { criterion1, criterion2 };
}

export function renderSummary(outcomes: CaseOutcome[], verdict: Verdict): string {
	const rows = outcomes
		.map((o) => {
			const r = o.result;
			return `| ${o.caseId} | ${r?.status ?? "—"} | ${r?.limit ?? "—"} | ${r?.turns ?? "—"} | ${
				r?.usage.total ?? "—"
			} | ${(r?.usage.cost ?? 0).toFixed(4)} | ${o.reconcile?.ok ? "ok" : "FAIL"} | ${Math.round(o.elapsedMs / 1000)}s |`;
		})
		.join("\n");

	// 措辞受规格 §1.6 约束:必须写明是 5 题子集,不得简写成「判据①通过」。
	return [
		"# S0 出口判据验证报告",
		"",
		`> 用例范围:**${outcomes.length} 题子集**(设计文档 §8 判据①原文是 15 题)。`,
		"> 每族取 1、5 族全覆盖,族内 3 道变体只验 1 道 —— 族内差异未覆盖。见规格 B8。",
		"",
		"| case | status | limit | turns | tokens | cost(元) | reconcile | 耗时 |",
		"|---|---|---|---|---|---|---|---|",
		rows,
		"",
		"## 判据",
		"",
		`- **判据①(${outcomes.length} 题子集全部 completed)**:${verdict.criterion1.pass ? "通过" : "**不通过**"} —— ${verdict.criterion1.detail}`,
		`- **判据②(工具调用与 EVAL_TASK_LOG 逐条对上)**:${verdict.criterion2.pass ? "通过" : "**不通过**"} —— ${verdict.criterion2.detail}`,
		"- **判据③(四类限额)**:见 `limits/summary.md`",
		"- **判据④(并发零污染)**:已由 `test/isolation.test.ts` 覆盖",
		"",
	].join("\n");
}

export interface RunCaseArgs {
	evalCase: EvalCase;
	prompt: string;
	evalRoot: string;
	outDir: string;
	profilePath: string;
	/** 已把 mcpServers.args 解析成绝对路径的临时 spec。 */
	specPath: string;
	timeoutMs: number;
}

export async function runCase(args: RunCaseArgs): Promise<CaseOutcome> {
	const caseDir = join(args.outDir, args.evalCase.id);
	const taskLogDir = join(caseDir, "tasklog");
	const trajectoryPath = join(caseDir, "trajectory.jsonl");
	await mkdir(taskLogDir, { recursive: true });

	const started = Date.now();
	let stdout = "";
	let cliExitCode = 0;
	let errorMessage: string | undefined;
	try {
		const done = await execFileAsync(
			process.execPath,
			[
				CLI,
				"run",
				"--spec",
				args.specPath,
				"--profile",
				args.profilePath,
				"--workdir",
				join(caseDir, "workdir"),
				"--trajectory",
				trajectoryPath,
				"--runId",
				args.evalCase.id,
				"--input",
				args.prompt,
			],
			{
				// EVAL_TASK_LOG 无后缀 → fixture 当目录用,两个 server 合并写 tool_calls.jsonl。
				env: { ...process.env, EVAL_TASK_LOG: taskLogDir },
				// 必须给 timeout:CLI 死锁时子进程会活过调用方,攒孤儿进程。
				timeout: args.timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		stdout = done.stdout;
	} catch (error) {
		const withCode = error as { code?: number; stdout?: string; message?: string };
		// CLI 在 status !== "completed" 时 exitCode=2 并**仍然打印合法 RunResult**(main.ts:70-71),
		// 所以 exit 2 不代表没有结果 —— 必须继续解析 stdout。
		cliExitCode = typeof withCode.code === "number" ? withCode.code : 1;
		stdout = withCode.stdout ?? "";
		errorMessage = withCode.message;
	}

	let result: RunResult | undefined;
	const lastLine = stdout.trim().split("\n").at(-1) ?? "";
	if (lastLine.startsWith("{")) {
		try {
			result = JSON.parse(lastLine) as RunResult;
		} catch {
			errorMessage ??= `unparseable CLI stdout: ${lastLine.slice(0, 200)}`;
		}
	}

	let report: ReconcileReport | undefined;
	try {
		report = await reconcile(trajectoryPath, join(taskLogDir, "tool_calls.jsonl"), ["policy_query", "expense_query"]);
	} catch (error) {
		errorMessage ??= `reconcile failed: ${error instanceof Error ? error.message : String(error)}`;
	}

	const outcome: CaseOutcome = {
		caseId: args.evalCase.id,
		result,
		reconcile: report,
		cliExitCode,
		error: errorMessage,
		elapsedMs: Date.now() - started,
	};
	await writeFile(join(caseDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
	return outcome;
}
