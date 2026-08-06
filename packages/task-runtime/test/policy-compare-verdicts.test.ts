import { describe, expect, it } from "vitest";
import type { ClausePair } from "../src/runtime/policy-compare/types.ts";
import { batchPairs, parseVerdicts, renderBatchPrompt } from "../src/runtime/policy-compare/verdicts.ts";

const pair = (n: number, textLen = 10): ClausePair => ({
	externalClause: { seq: n, clausePath: `第${n}条`, text: "外".repeat(textLen) },
	internalObligation: {
		chunkId: `C-${n}`,
		clausePath: `内第${n}条`,
		docTitle: "内规",
		docNo: "内〔2026〕1号",
		deonticType: "obligation",
		evidence: "应当",
		text: "内".repeat(textLen),
		sourceCode: `SC-${n}`,
	},
	matchKind: "exact",
});

describe("batchPairs", () => {
	it("按 batchSize 切分", () => {
		const got = batchPairs(
			Array.from({ length: 17 }, (_, i) => pair(i)),
			8,
		);
		expect(got.map((b) => b.length)).toEqual([8, 8, 1]);
	});

	it("空输入回空数组,不产生空批", () => {
		expect(batchPairs([], 8)).toEqual([]);
	});

	it("单批超字符上限时对半分,不截断正文", () => {
		// 每对约 2 * 2000 字符;上限设 5000 ⇒ 4 对的批必须再分
		const got = batchPairs(
			Array.from({ length: 4 }, (_, i) => pair(i, 2000)),
			4,
			5000,
		);
		expect(got.length).toBeGreaterThan(1);
		const total = got.reduce((n, b) => n + b.length, 0);
		expect(total).toBe(4);
		// 正文一字未少
		expect(got.flat().every((p) => p.externalClause.text.length === 2000)).toBe(true);
	});

	it("单独一对就超上限时不再分,原样成批(不丢数据)", () => {
		const got = batchPairs([pair(0, 50_000)], 8, 5000);
		expect(got).toHaveLength(1);
		expect(got[0]).toHaveLength(1);
	});
});

describe("renderBatchPrompt", () => {
	it("每对带全局序号、双方正文与条款定位", () => {
		const text = renderBatchPrompt([pair(3)], 5);
		expect(text).toContain("pairIndex: 5");
		expect(text).toContain("第3条");
		expect(text).toContain("内第3条");
	});

	it("baseIndex 让第二批的序号接着第一批走", () => {
		const text = renderBatchPrompt([pair(0), pair(1)], 8);
		expect(text).toContain("pairIndex: 8");
		expect(text).toContain("pairIndex: 9");
	});
});

describe("parseVerdicts", () => {
	it("读围栏包裹的 verdicts 数组", () => {
		const text = '```json\n{"verdicts":[{"pairIndex":0,"state":"covered"}]}\n```';
		expect(parseVerdicts(text)).toEqual([{ pairIndex: 0, state: "covered" }]);
	});

	it("读裸 JSON 对象", () => {
		const got = parseVerdicts('{"verdicts":[{"pairIndex":1,"state":"missing","gap":"缺期限","suggestion":"补"}]}');
		expect(got).toEqual([{ pairIndex: 1, state: "missing", gap: "缺期限", suggestion: "补" }]);
	});

	it("丢掉 state 非法的条目", () => {
		expect(parseVerdicts('{"verdicts":[{"pairIndex":0,"state":"maybe"}]}')).toEqual([]);
	});

	it("丢掉 pairIndex 不是整数的条目", () => {
		expect(parseVerdicts('{"verdicts":[{"pairIndex":"0","state":"covered"}]}')).toEqual([]);
	});

	it("解析不出来回空数组,不抛", () => {
		expect(parseVerdicts("我觉得都覆盖了")).toEqual([]);
	});

	it("忽略模型多写的字段(只收四个)", () => {
		const got = parseVerdicts(
			'{"verdicts":[{"pairIndex":0,"state":"conflict","conflictType":"口径冲突","externalClause":"模型编的正文"}]}',
		);
		expect(got).toEqual([{ pairIndex: 0, state: "conflict", conflictType: "口径冲突" }]);
	});

	// 额外覆盖测试 — 补充分支覆盖

	it("丢掉非对象的 verdicts 数组元素", () => {
		expect(parseVerdicts('{"verdicts":["string",null,123,true]}')).toEqual([]);
	});

	it("丢掉空字符串的可选字段", () => {
		const got = parseVerdicts(
			'{"verdicts":[{"pairIndex":0,"state":"missing","gap":"","suggestion":"补","conflictType":""}]}',
		);
		expect(got).toEqual([{ pairIndex: 0, state: "missing", suggestion: "补" }]);
	});

	it("保留非空的所有可选字段", () => {
		const got = parseVerdicts(
			'{"verdicts":[{"pairIndex":0,"state":"conflict","gap":"缺条款","suggestion":"加条款","conflictType":"口径冲突"}]}',
		);
		expect(got).toEqual([
			{ pairIndex: 0, state: "conflict", gap: "缺条款", suggestion: "加条款", conflictType: "口径冲突" },
		]);
	});

	it("丢掉 pairIndex 不是整数类型的条目(浮点数)", () => {
		expect(parseVerdicts('{"verdicts":[{"pairIndex":0.5,"state":"covered"}]}')).toEqual([]);
	});

	it("处理混合数组(有效+无效条目)", () => {
		const got = parseVerdicts(
			'{"verdicts":[{"pairIndex":0,"state":"covered"},{"pairIndex":"bad","state":"missing"},{"pairIndex":1,"state":"invalid"},{"pairIndex":2,"state":"partial"}]}',
		);
		expect(got).toEqual([
			{ pairIndex: 0, state: "covered" },
			{ pairIndex: 2, state: "partial" },
		]);
	});

	it("verdicts 不是数组时返回空数组", () => {
		expect(parseVerdicts('{"verdicts":"not an array"}')).toEqual([]);
		expect(parseVerdicts('{"verdicts":null}')).toEqual([]);
		expect(parseVerdicts('{"verdicts":{}}')).toEqual([]);
	});

	it("使用无标签围栏提取 JSON", () => {
		const text = '```\n{"verdicts":[{"pairIndex":0,"state":"covered"}]}\n```';
		expect(parseVerdicts(text)).toEqual([{ pairIndex: 0, state: "covered" }]);
	});
});

describe("batchPairs 分支覆盖", () => {
	it("递归对半分:中等批超上限时对半分裂", () => {
		// 创建 3 对，每对 4000 字符（外部2000+内部2000）；上限 5000
		// 初始不分，执行 splitUntilFits([p0,p1,p2], 5000):
		//   - batchChars = 12000 > 5000，对半分：mid = ceil(3/2) = 2
		//   - splitUntilFits([p0,p1], 5000): batchChars = 8000 > 5000
		//     - 对半分：mid = ceil(2/2) = 1
		//     - splitUntilFits([p0], 5000): batchChars = 4000 <= 5000，出批
		//     - splitUntilFits([p1], 5000): batchChars = 4000 <= 5000，出批
		//   - splitUntilFits([p2], 5000): batchChars = 4000 <= 5000，出批
		const got = batchPairs(
			Array.from({ length: 3 }, (_, i) => pair(i, 2000)),
			5,
			5000,
		);
		expect(got).toHaveLength(3);
		expect(got.every((b) => b.length === 1)).toBe(true);
	});

	it("batchSize 大于 pairs.length 时单批处理", () => {
		const pairs = Array.from({ length: 3 }, (_, i) => pair(i, 10));
		const got = batchPairs(pairs, 10);
		expect(got).toHaveLength(1);
		expect(got[0].length).toBe(3);
	});

	it("多批需要分裂时保证元素总数不变", () => {
		// 16 对分 8 个一批，第二批因超字符上限需要对半分
		const pairs = Array.from({ length: 16 }, (_, i) => pair(i, 2000));
		const got = batchPairs(pairs, 8, 5000);
		const total = got.reduce((n, b) => n + b.length, 0);
		expect(total).toBe(16);
		// 验证不产生空批
		expect(got.every((b) => b.length > 0)).toBe(true);
	});
});

describe("renderBatchPrompt 细节", () => {
	it("处理可选字段为 null 的情况", () => {
		const p: ClausePair = {
			externalClause: { seq: 0, clausePath: "条1", text: "外文本" },
			internalObligation: {
				chunkId: "C-0",
				clausePath: null,
				docTitle: null,
				docNo: null,
				deonticType: "obligation",
				evidence: null,
				text: "内文本",
				sourceCode: null,
			},
			matchKind: "exact",
		};
		const text = renderBatchPrompt([p], 0);
		expect(text).toContain("pairIndex: 0");
		expect(text).toContain("外文本");
		expect(text).toContain("内文本");
	});

	it("多对时每对单独列出", () => {
		const text = renderBatchPrompt([pair(0, 10), pair(1, 10), pair(2, 10)], 5);
		expect(text).toContain("pairIndex: 5");
		expect(text).toContain("pairIndex: 6");
		expect(text).toContain("pairIndex: 7");
		// 验证分隔符
		expect(text).toContain("---");
	});
});
