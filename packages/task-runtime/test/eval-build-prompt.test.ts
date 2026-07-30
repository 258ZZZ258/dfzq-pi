import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/eval/build-prompt.ts";
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
