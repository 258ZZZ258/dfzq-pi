import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrompt, loadPromptParts } from "../src/eval/build-prompt.ts";
import type { EvalCase } from "../src/eval/cases.ts";

const CASE: EvalCase = {
	id: "L1-001",
	level: "L1",
	category: "policy_qa",
	caseFamily: "policy_and_version",
	promptVariants: { precise: "单笔费用报销达到多少金额需要部门总经理审批?" },
};

const PARTS = { rolePrompt: "ROLE_PROMPT_BODY", outputContract: "OUTPUT_CONTRACT_BODY" };

describe("buildPrompt", () => {
	it("reproduces run_eval.py build_prompt segment for segment", () => {
		const prompt = buildPrompt(CASE, "precise", PARTS);
		expect(prompt).toBe(
			[
				"请直接回答这个审计问题: 单笔费用报销达到多少金额需要部门总经理审批?",
				"这是完整任务,不要要求用户再提供任务或文件,不要探索项目目录,不要寻找评测入口。",
				"必须使用已连接的 MCP 工具查询制度或业务事实后再回答。",
				"ROLE_PROMPT_BODY",
				"OUTPUT_CONTRACT_BODY",
				"任务元数据: id=L1-001; level=L1; category=policy_qa.",
				"现在开始,最终只输出一个可解析 JSON 代码块。",
			].join("\n\n"),
		);
	});

	it("throws when the requested variant is absent", () => {
		expect(() => buildPrompt(CASE, "loose", PARTS)).toThrow(/loose/);
	});
});

describe("loadPromptParts", () => {
	let root: string | undefined;

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	// 回归用例:run_eval.py 的 read_text() 会 .strip() 文件内容,不 trim 会让 buildPrompt
	// 拼出的 prompt 比 Python 基线多几行空行 —— 表面像同一条 prompt,实则不是同口径。
	// 断言必须是严格相等(而非 toContain),否则 trim 被删掉也测不出来。
	it("trims leading/trailing whitespace from the fixture files", async () => {
		root = await mkdtemp(join(tmpdir(), "dfzq-prompt-parts-"));
		const dir = join(root, "fixtures");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "audit_role_prompt.md"), "\n\n  ROLE BODY  \n\n");
		await writeFile(join(dir, "output_contract.md"), "\n\n  CONTRACT BODY  \n\n");

		const parts = await loadPromptParts(root);

		expect(parts.rolePrompt).toBe("ROLE BODY");
		expect(parts.outputContract).toBe("CONTRACT BODY");
	});
});
