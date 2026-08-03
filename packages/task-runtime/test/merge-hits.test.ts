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

	it("does NOT sort by score", () => {
		// 若实现改成按 score 降序,这条会翻红 —— RRF 分跨查询不可比(规格 §2.3)
		const got = mergeHitsRoundRobin([[hit("低", 0.01)], [hit("高", 0.99)]], 10);
		expect(got.map((h) => h.clause_id)).toEqual(["低", "高"]);
	});

	it("returns [] for empty input or a non-positive limit", () => {
		expect(mergeHitsRoundRobin([], 10)).toEqual([]);
		expect(mergeHitsRoundRobin([[hit("A1")]], 0)).toEqual([]);
	});
});
