import { describe, expect, it } from "vitest";
import { createArtifactStore, parseArtifact } from "../src/runtime/policy-compare/artifact-store.ts";

const artifact = {
	upload_id: "U1",
	source: { filename: "a.pdf", object_key: "upload/U1/a.pdf", sha256: "x", content_type: "application/pdf" },
	doc: { title: "某某管理办法", page_count: 12, chunk_count: 3 },
	chunks: [
		{
			seq: 0,
			clause_path: "第一章 总则/第一条",
			chunk_type: "clause",
			text: "第一条正文",
			page_start: 1,
			page_end: 1,
			is_table: false,
		},
		{ seq: 1, clause_path: "附表一", chunk_type: "table", text: "表格", page_start: 2, page_end: 2, is_table: true },
		{
			seq: 2,
			clause_path: "第一章 总则/第二条",
			chunk_type: "clause",
			text: "第二条正文",
			page_start: 1,
			page_end: 1,
			is_table: false,
		},
	],
	markdown: "# 某某管理办法",
};

describe("parseArtifact", () => {
	it("只留 chunk_type=clause 且非表格的块", () => {
		const got = parseArtifact(JSON.stringify(artifact));
		expect(got.clauses.map((c) => c.seq)).toEqual([0, 2]);
		expect(got.title).toBe("某某管理办法");
		expect(got.uploadId).toBe("U1");
	});

	it("字段名从 snake_case 翻成 camelCase", () => {
		const got = parseArtifact(JSON.stringify(artifact));
		expect(got.clauses[0]).toEqual({
			seq: 0,
			clausePath: "第一章 总则/第一条",
			text: "第一条正文",
			pageStart: 1,
			pageEnd: 1,
		});
	});

	it("chunks 缺失或不是数组 → 抛错,不返回空文档", () => {
		expect(() => parseArtifact(JSON.stringify({ upload_id: "U1", doc: {} }))).toThrow(/chunks/);
	});

	it("一个条款块都没有 → 抛错(整篇没有可比对的条款,不能静默当成零差异)", () => {
		const empty = { ...artifact, chunks: [artifact.chunks[1]] };
		expect(() => parseArtifact(JSON.stringify(empty))).toThrow(/条款/);
	});

	it("非 JSON → 抛错,message 带前缀便于定位", () => {
		expect(() => parseArtifact("不是 json")).toThrow(/artifact/);
	});

	// 补充的分支覆盖
	it("text 为空串的块被跳过", () => {
		const withEmptyText = {
			...artifact,
			chunks: [
				{
					seq: 0,
					clause_path: "第一条",
					chunk_type: "clause",
					text: "",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
				{
					seq: 1,
					clause_path: "第二条",
					chunk_type: "clause",
					text: "第二条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(withEmptyText));
		expect(got.clauses).toHaveLength(1);
		expect(got.clauses[0].text).toBe("第二条正文");
	});

	it("text 为纯空白的块被跳过", () => {
		const withWhitespaceText = {
			...artifact,
			chunks: [
				{
					seq: 0,
					clause_path: "第一条",
					chunk_type: "clause",
					text: "   \t\n  ",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
				{
					seq: 1,
					clause_path: "第二条",
					chunk_type: "clause",
					text: "第二条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(withWhitespaceText));
		expect(got.clauses).toHaveLength(1);
		expect(got.clauses[0].text).toBe("第二条正文");
	});

	it("seq 缺失时回落到 clauses.length", () => {
		const noSeq = {
			...artifact,
			chunks: [
				{
					clause_path: "第一条",
					chunk_type: "clause",
					text: "第一条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
				{
					clause_path: "第二条",
					chunk_type: "clause",
					text: "第二条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(noSeq));
		expect(got.clauses[0].seq).toBe(0);
		expect(got.clauses[1].seq).toBe(1);
	});

	it("seq 为非数字时回落到 clauses.length", () => {
		const invalidSeq = {
			...artifact,
			chunks: [
				{
					seq: "not-a-number",
					clause_path: "第一条",
					chunk_type: "clause",
					text: "第一条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
				{
					seq: "invalid",
					clause_path: "第二条",
					chunk_type: "clause",
					text: "第二条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(invalidSeq));
		expect(got.clauses[0].seq).toBe(0);
		expect(got.clauses[1].seq).toBe(1);
	});

	it("page_start/page_end 为非数字时回落 undefined", () => {
		const invalidPages = {
			...artifact,
			chunks: [
				{
					seq: 0,
					clause_path: "第一条",
					chunk_type: "clause",
					text: "第一条正文",
					page_start: "not-a-number",
					page_end: "also-not-a-number",
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(invalidPages));
		expect(got.clauses[0].pageStart).toBeUndefined();
		expect(got.clauses[0].pageEnd).toBeUndefined();
	});

	it("clause_path 缺失时为空串", () => {
		const noClausePath = {
			...artifact,
			chunks: [{ seq: 0, chunk_type: "clause", text: "条文内容", page_start: 1, page_end: 1, is_table: false }],
		};
		const got = parseArtifact(JSON.stringify(noClausePath));
		expect(got.clauses[0].clausePath).toBe("");
	});

	it("clause_path 为非字符串时为空串", () => {
		const invalidClausePath = {
			...artifact,
			chunks: [
				{
					seq: 0,
					clause_path: 123,
					chunk_type: "clause",
					text: "条文内容",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(invalidClausePath));
		expect(got.clauses[0].clausePath).toBe("");
	});

	it("doc.title 缺失时为空串", () => {
		const noTitle = { ...artifact, doc: {} };
		const got = parseArtifact(JSON.stringify(noTitle));
		expect(got.title).toBe("");
	});

	it("doc.title 为非字符串时为空串", () => {
		const invalidTitle = { ...artifact, doc: { title: 123 } };
		const got = parseArtifact(JSON.stringify(invalidTitle));
		expect(got.title).toBe("");
	});

	it("upload_id 缺失时为空串", () => {
		// biome-ignore lint/correctness/noUnusedVariables: 故意排除 upload_id
		const { upload_id, ...noUploadId } = artifact;
		const got = parseArtifact(JSON.stringify(noUploadId));
		expect(got.uploadId).toBe("");
	});

	it("upload_id 为非字符串时强转为字符串", () => {
		const numericUploadId = { ...artifact, upload_id: 12345 };
		const got = parseArtifact(JSON.stringify(numericUploadId));
		expect(got.uploadId).toBe("12345");
	});

	it("chunk_type 不是 clause 时被过滤", () => {
		const onlyTable = {
			...artifact,
			chunks: [
				{ seq: 0, clause_path: "表", chunk_type: "toc", text: "目录", page_start: 1, page_end: 1, is_table: false },
			],
		};
		expect(() => parseArtifact(JSON.stringify(onlyTable))).toThrow(/条款/);
	});

	it("is_table 为 true 的块被过滤", () => {
		const onlyTable = {
			...artifact,
			chunks: [
				{
					seq: 0,
					clause_path: "表",
					chunk_type: "clause",
					text: "表格",
					page_start: 1,
					page_end: 1,
					is_table: true,
				},
			],
		};
		expect(() => parseArtifact(JSON.stringify(onlyTable))).toThrow(/条款/);
	});

	it("chunks 为空数组时抛错(零条款块)", () => {
		const emptyChunks = { ...artifact, chunks: [] };
		expect(() => parseArtifact(JSON.stringify(emptyChunks))).toThrow(/条款/);
	});

	it("text 缺失的块被跳过", () => {
		const noText = {
			...artifact,
			chunks: [
				{ seq: 0, clause_path: "第一条", chunk_type: "clause", page_start: 1, page_end: 1, is_table: false },
				{
					seq: 1,
					clause_path: "第二条",
					chunk_type: "clause",
					text: "第二条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(noText));
		expect(got.clauses).toHaveLength(1);
		expect(got.clauses[0].text).toBe("第二条正文");
	});

	it("text 为非字符串时被跳过", () => {
		const nonStringText = {
			...artifact,
			chunks: [
				{
					seq: 0,
					clause_path: "第一条",
					chunk_type: "clause",
					text: 123,
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
				{
					seq: 1,
					clause_path: "第二条",
					chunk_type: "clause",
					text: "第二条正文",
					page_start: 1,
					page_end: 1,
					is_table: false,
				},
			],
		};
		const got = parseArtifact(JSON.stringify(nonStringText));
		expect(got.clauses).toHaveLength(1);
		expect(got.clauses[0].text).toBe("第二条正文");
	});

	it("docNo 未在返回中出现(与 ExternalDocument 接口一致)", () => {
		const got = parseArtifact(JSON.stringify(artifact));
		expect(got).toHaveProperty("docNo");
		expect(got.docNo).toBeUndefined();
	});
});

describe("createArtifactStore", () => {
	it("按 bucket + artifactKey 取对象并解析", async () => {
		const seen: Array<[string, string]> = [];
		const store = createArtifactStore({
			bucket: "uploads",
			get: async (bucket, key) => {
				seen.push([bucket, key]);
				return JSON.stringify(artifact);
			},
		});
		const got = await store.fetch("artifact/U1.json");
		expect(seen).toEqual([["uploads", "artifact/U1.json"]]);
		expect(got.clauses).toHaveLength(2);
	});

	it("如果 ObjectGetter 返回的 JSON 无效则抛错", async () => {
		const store = createArtifactStore({
			bucket: "uploads",
			get: async () => "invalid json",
		});
		await expect(store.fetch("artifact/U1.json")).rejects.toThrow(/artifact/);
	});

	it("如果 ObjectGetter 返回的 JSON 无条款块则抛错", async () => {
		const store = createArtifactStore({
			bucket: "uploads",
			get: async () => JSON.stringify({ upload_id: "U1", chunks: [] }),
		});
		await expect(store.fetch("artifact/U1.json")).rejects.toThrow(/条款/);
	});
});
