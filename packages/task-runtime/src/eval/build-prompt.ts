import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCase } from "./cases.ts";

export interface PromptParts {
	rolePrompt: string;
	outputContract: string;
}

export async function loadPromptParts(evalRoot: string): Promise<PromptParts> {
	const [rolePrompt, outputContract] = await Promise.all([
		readFile(join(evalRoot, "fixtures", "audit_role_prompt.md"), "utf8"),
		readFile(join(evalRoot, "fixtures", "output_contract.md"), "utf8"),
	]);
	// run_eval.py 的 read_text() 是 `Path(path).read_text(...).strip()` —— 两份 fixture
	// 文件都以单个 "\n" 收尾,不 trim 的话拼出来的 prompt 会比 Python 侧多一行空行,
	// 表面像是同一份 prompt,实则每次 role/contract 段后都多一个换行,不是同口径。
	return { rolePrompt: rolePrompt.trim(), outputContract: outputContract.trim() };
}

/**
 * 逐段照抄 blackbox-eval `runner/run_eval.py:74-91` 的 build_prompt。
 *
 * 顺序与文案**不得改动** —— 9 个基线框架吃的就是这条 prompt,改一个字就不是同口径。
 * role prompt 与 output contract 都在这条 user prompt 里,不走 system prompt,
 * 所以 specs/blackbox-eval.json 里没有 systemPrompt 字段。
 */
export function buildPrompt(evalCase: EvalCase, variant: string, parts: PromptParts): string {
	const taskPrompt = evalCase.promptVariants[variant];
	if (!taskPrompt) {
		throw new Error(`Case ${evalCase.id} has no prompt variant "${variant}"`);
	}
	return [
		`请直接回答这个审计问题: ${taskPrompt}`,
		"这是完整任务,不要要求用户再提供任务或文件,不要探索项目目录,不要寻找评测入口。",
		"必须使用已连接的 MCP 工具查询制度或业务事实后再回答。",
		parts.rolePrompt,
		parts.outputContract,
		`任务元数据: id=${evalCase.id}; level=${evalCase.level}; category=${evalCase.category}.`,
		"现在开始,最终只输出一个可解析 JSON 代码块。",
	].join("\n\n");
}
