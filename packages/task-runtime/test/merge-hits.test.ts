import { describe, expect, it } from "vitest";
import { mergeHitsRoundRobin, type RetrievalHit } from "../src/runtime/merge-hits.ts";

const hit = (id: string, score = 0): RetrievalHit => ({ clause_id: id, score });

describe("mergeHitsRoundRobin", () => {
	it("interleaves by rank, first list first", () => {
		const got = mergeHitsRoundRobin(
			[
				[hit("A1"), hit("A2")],
				[hit("B1"), hit("B2")],
			],
			10,
		);
		expect(got.map((h) => h.clause_id)).toEqual(["A1", "B1", "A2", "B2"]);
	});

	it("drops duplicates, keeping the first occurrence", () => {
		const got = mergeHitsRoundRobin(
			[
				[hit("X"), hit("A2")],
				[hit("X"), hit("B2")],
			],
			10,
		);
		expect(got.map((h) => h.clause_id)).toEqual(["X", "A2", "B2"]);
	});

	it("stops at the limit", () => {
		const got = mergeHitsRoundRobin([[hit("A1"), hit("A2"), hit("A3")], [hit("B1")]], 2);
		expect(got.map((h) => h.clause_id)).toEqual(["A1", "B1"]);
	});

	it("keeps draining longer lists after shorter ones run out", () => {
		const got = mergeHitsRoundRobin([[hit("A1")], [hit("B1"), hit("B2"), hit("B3")]], 10);
		expect(got.map((h) => h.clause_id)).toEqual(["A1", "B1", "B2", "B3"]);
	});

	it("does not reorder by score — neither across lists nor within one", () => {
		// 轮询交错 → A(rank0,list0) → C(rank0,list1) → B(rank1,list0)
		// 按 score 降序会得到 B,A,C;升序会得到 C,A,B;先对 list0 内部按分重排再交错会得到 B,C,A。
		// 三种「顺手优化」的结果都与期望不同,所以这条用例把它们一起堵住。
		const got = mergeHitsRoundRobin([[hit("A", 0.5), hit("B", 0.9)], [hit("C", 0.1)]], 10);
		expect(got.map((h) => h.clause_id)).toEqual(["A", "C", "B"]);
	});

	it("counts toward the limit only after deduping", () => {
		// 若实现改成「先取满 limit 条原始候选、事后去重」,会先拿到 [X, X]、去重后只剩 1 条。
		const got = mergeHitsRoundRobin(
			[
				[hit("X"), hit("A2")],
				[hit("X"), hit("B2")],
			],
			2,
		);
		expect(got.map((h) => h.clause_id)).toEqual(["X", "A2"]);
	});

	it("returns [] for empty input or a non-positive limit", () => {
		expect(mergeHitsRoundRobin([], 10)).toEqual([]);
		expect(mergeHitsRoundRobin([[hit("A1")]], 0)).toEqual([]);
	});
});
