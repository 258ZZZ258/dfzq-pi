import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CoverageResult } from "../src/runtime/policy-compare/types.ts";
import { validateCoverageResult } from "../src/runtime/policy-compare/validate-result.ts";

const schema = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-compare/coverage.schema.json", import.meta.url)), "utf8"),
);

const row = () => ({
	index: 1,
	tabKey: "missing" as const,
	conflictType: "治理缺失",
	externalClause: "外规正文",
	internalClause: "内规正文",
	judgement: "缺失要求",
	source: "费用报销管理办法 第八条",
	suggestion: "补充留痕要求",
	basis: {
		internalChunkId: "C-1",
		internalSourceCode: "SC-1",
		externalClausePath: "第五条",
		externalDocNo: "证监发〔2026〕1号",
		matchKind: "exact" as const,
	},
});

const good = (): CoverageResult => ({
	compareType: "external_to_internal",
	metrics: { checked: 2, missing: 1, conflict: 0, covered: 1, unmatched: 0, linked: 0 },
	rows: [row()],
	gaps: [],
	finish_reason: "stop",
});

const ctx = {
	internalChunkIds: new Set(["C-1"]),
	externalTexts: new Set(["外规正文"]),
	internalTexts: new Set(["内规正文"]),
	checkedCount: 2,
};

describe("validateCoverageResult", () => {
	it("合格结果通过", () => {
		expect(validateCoverageResult(good(), ctx, schema)).toEqual({ ok: true });
	});

	it("schema 不合(tabKey 越界)判负", () => {
		const bad = good();
		(bad.rows[0] as { tabKey: string }).tabKey = "overview";
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
	});

	it("basis.internalChunkId 不在阶段 2 结果集 → 判负(反幻觉 1)", () => {
		const bad = good();
		bad.rows[0].basis.internalChunkId = "臆造-999";
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.detail).toContain("臆造-999");
	});

	it("externalClause 不是阶段 1 的原文 → 判负(反幻觉 2)", () => {
		const bad = good();
		bad.rows[0].externalClause = "模型改写过的正文";
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.detail).toContain("externalClause");
	});

	it("internalClause 不是阶段 2 的原文 → 判负(反幻觉 2)", () => {
		const bad = good();
		bad.rows[0].internalClause = "模型改写过的内规";
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.detail).toContain("internalClause");
	});

	it("metrics.checked 与阶段 2 的 total 不符 → 判负(反幻觉 3)", () => {
		const bad = good();
		bad.metrics.checked = 99;
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.detail).toContain("checked");
	});

	it("metrics 四项之和 ≠ checked → 判负(反幻觉 4)", () => {
		const bad = good();
		bad.metrics.covered = 5;
		bad.metrics.checked = 2;
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
	});

	// 补充测试覆盖
	it("rows 为空时仍检查 metrics(反幻觉 3+4)", () => {
		const empty = good();
		empty.rows = [];
		empty.metrics = { checked: 2, missing: 0, conflict: 0, covered: 2, unmatched: 0, linked: 0 };
		const got = validateCoverageResult(empty, ctx, schema);
		expect(got.ok).toBe(true);
	});

	it("rows 为空但 metrics 不自洽 → 判负(反幻觉 4)", () => {
		const bad = good();
		bad.rows = [];
		// checked = 2 符合 checkedCount,但 missing+conflict+covered+unmatched = 1+0+1+0 = 2 不等于 checked 本身(此处会不符)
		bad.metrics = { checked: 2, missing: 1, conflict: 0, covered: 1, unmatched: 0, linked: 0 };
		const ctx2 = {
			internalChunkIds: new Set(["C-1"]),
			externalTexts: new Set(["外规正文"]),
			internalTexts: new Set(["内规正文"]),
			checkedCount: 2,
		};
		// 注意:此处 missing+conflict+covered+unmatched = 1+0+1+0 = 2,等于 checked,应该通过
		const got = validateCoverageResult(bad, ctx2, schema);
		expect(got.ok).toBe(true);

		// 真正测试不自洽的情况:改变 covered 让它们不相等
		bad.metrics.covered = 2;
		const got2 = validateCoverageResult(bad, ctx2, schema);
		expect(got2.ok).toBe(false);
		if (!got2.ok) expect(got2.detail).toContain("metrics 不自洽");
	});

	it("多行中间某行 externalClause 不对 → 判负且指出行号", () => {
		const bad = good();
		const row2 = row();
		row2.index = 2;
		row2.basis.internalChunkId = "C-2";
		bad.rows = [row(), row2];
		bad.rows[1].externalClause = "不存在的外规正文";
		bad.metrics.checked = 3;
		const ctx2 = {
			internalChunkIds: new Set(["C-1", "C-2"]),
			externalTexts: new Set(["外规正文", "另一个外规正文"]),
			internalTexts: new Set(["内规正文", "另一个内规正文"]),
			checkedCount: 3,
		};
		const got = validateCoverageResult(bad, ctx2, schema);
		expect(got.ok).toBe(false);
		if (!got.ok) {
			expect(got.detail).toContain("第 2 行");
			expect(got.detail).toContain("externalClause");
		}
	});

	it("schema 校验失败时的 detail 包含错误路径", () => {
		const bad = good();
		bad.metrics = {} as never;
		const got = validateCoverageResult(bad, ctx, schema);
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.detail).toContain("metrics");
	});
});
