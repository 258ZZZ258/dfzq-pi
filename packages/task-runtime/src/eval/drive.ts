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
	if (outcomes.length === 0) {
		// 空跑批是 vacuous 陷阱在「用例数」这一层的等价物:两个 filter 在 outcomes=[]
		// 时都会真空成立(notCompleted.length===0 / bad.length===0),发一份
		// 「0 题全部 completed / 0 题全部 reconcile.ok」的假通过凭证。必须显式挡住,
		// 不能靠 filter 的真空语义兜底。
		const detail = "没有跑任何用例 —— 判据无法成立";
		return {
			criterion1: { pass: false, detail },
			criterion2: { pass: false, detail },
		};
	}

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

/**
 * 实际跑了什么范围:摘要的措辞必须跟着这个走,不能是与调用方式无关的静态字符串 ——
 * 否则 `--all` 真跑满 15 题时,摘要还在说「族内差异未覆盖」就是彻底的假话。
 *
 * - default:未传 `--all`/`--cases`,即 `DEFAULT_CASE_IDS` 那 5 题子集。
 * - all:传了 `--all`,15 题全集 —— 判据①原文要求的完整范围。
 * - custom:传了 `--cases`,任意自定义题目组合,不声称任何族覆盖性质。
 */
export interface CaseSelection {
	mode: "default" | "all" | "custom";
}

export function renderSummary(
	outcomes: CaseOutcome[],
	verdict: Verdict,
	selection: CaseSelection = { mode: "default" },
): string {
	const rows = outcomes
		.map((o) => {
			const r = o.result;
			return `| ${o.caseId} | ${r?.status ?? "—"} | ${r?.limit ?? "—"} | ${r?.turns ?? "—"} | ${
				r?.usage.total ?? "—"
			} | ${(r?.usage.cost ?? 0).toFixed(4)} | ${o.reconcile?.ok ? "ok" : "FAIL"} | ${Math.round(o.elapsedMs / 1000)}s |`;
		})
		.join("\n");

	// 措辞注意:「判据①」/「判据②」四个字加序号只应出现在下面「## 判据」区块里紧跟限定括号
	// 的标签里;这里的范围说明句要避免单独提到「判据①」——那是文档引用,不是通过断言,
	// 但会被 renderSummary 的裸断言测试(要求「判据①」全文任何地方都紧跟限定括号)误判。
	let scopeLines: string[];
	let criterion1Label: string;
	if (selection.mode === "all") {
		// 15 题全集:此时族内差异已经覆盖了,不能再写「族内差异未覆盖」。
		scopeLines = [`> 用例范围:**完整 15 题**(即设计文档 §8 定义的完整范围,不是抽样子集)。`];
		criterion1Label = "判据①(15 题全集全部 completed)";
	} else if (selection.mode === "custom") {
		// 自定义组合:既不是「每族取 1」,也不保证「5 族全覆盖」,不能借用 default 的族覆盖措辞,
		// 也不能反向拼出「5 族全覆盖」这个短语本身(否则会被当成声称了这个性质)。
		scopeLines = [
			`> 用例范围:**自定义 ${outcomes.length} 题**(--cases 指定,而非默认 5 题子集或完整 15 题)。范围由调用方决定,不代表任何族覆盖性质。`,
		];
		criterion1Label = `判据①(自定义 ${outcomes.length} 题全部 completed)`;
	} else {
		scopeLines = [
			`> 用例范围:**${outcomes.length} 题子集**(设计文档 §8 定义的完整范围是 15 题)。`,
			"> 每族取 1、5 族全覆盖,族内 3 道变体只验 1 道 —— 族内差异未覆盖。见规格 B8。",
		];
		criterion1Label = `判据①(${outcomes.length} 题子集全部 completed)`;
	}

	// 措辞受规格 §1.6 约束:必须写明实际跑了什么范围,不得出现裸的「判据①通过」/「判据②通过」
	// ——「判据①」/「判据②」在全文任何地方出现都必须紧跟限定括号,不能单独断言整体通过。
	return [
		"# S0 出口判据验证报告",
		"",
		...scopeLines,
		"",
		"| case | status | limit | turns | tokens | cost(元) | reconcile | 耗时 |",
		"|---|---|---|---|---|---|---|---|",
		rows,
		"",
		"## 判据",
		"",
		`- **${criterion1Label}**:${verdict.criterion1.pass ? "通过" : "**不通过**"} —— ${verdict.criterion1.detail}`,
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
