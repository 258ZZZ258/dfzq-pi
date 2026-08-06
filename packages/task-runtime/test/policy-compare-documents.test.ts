import { describe, expect, it } from "vitest";
import { buildProcessRequestBody, createDocumentsClient } from "../src/runtime/policy-compare/documents-client.ts";

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init ?? {})) as unknown as typeof fetch;
}

const req = { objectKey: "upload/U1/a.pdf", uploadId: "U1", filename: "a.pdf", corpusHint: "external" };

describe("createDocumentsClient", () => {
	it("POST 到 /v1/documents:process 并带 X-Internal-Token", async () => {
		let seenUrl = "";
		let seenToken: string | null = null;
		let seenBody: unknown;
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch((url, init) => {
				seenUrl = url;
				seenToken = new Headers(init.headers).get("X-Internal-Token");
				seenBody = JSON.parse(String(init.body));
				return new Response(
					JSON.stringify({
						upload_id: "U1",
						artifact_key: "artifact/U1.json",
						title: "某办法",
						page_count: 12,
						chunk_count: 34,
						chunk_types: ["clause"],
						status: "ok",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});
		const got = await client.process(req);
		expect(seenUrl).toBe("http://ai.local/v1/documents:process");
		expect(seenToken).toBe("T");
		expect(seenBody).toEqual({
			object_key: "upload/U1/a.pdf",
			upload_id: "U1",
			filename: "a.pdf",
			corpus_hint: "external",
		});
		expect(got).toEqual({
			uploadId: "U1",
			artifactKey: "artifact/U1.json",
			title: "某办法",
			pageCount: 12,
			chunkCount: 34,
			status: "ok",
		});
	});

	it("非 2xx 抛错,message 带状态码与响应体", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(() => new Response("unsupported type", { status: 415 })),
		});
		await expect(client.process(req)).rejects.toThrow(/415/);
	});

	it("响应体缺 artifact_key 抛错,不返回半截结果", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(JSON.stringify({ upload_id: "U1" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		});
		await expect(client.process(req)).rejects.toThrow(/artifact_key/);
	});

	it("internalToken 为空串时构造期就拒绝(fail-closed)", () => {
		expect(() => createDocumentsClient({ baseUrl: "http://ai.local", internalToken: "" })).toThrow(/internalToken/);
	});

	it("baseUrl 末尾有 / 时也能拼出相同的 URL", async () => {
		let seenUrl = "";
		const client = createDocumentsClient({
			baseUrl: "http://ai.local/",
			internalToken: "T",
			fetchImpl: fakeFetch((url) => {
				seenUrl = url;
				return new Response(
					JSON.stringify({
						upload_id: "U1",
						artifact_key: "artifact/U1.json",
						title: "某办法",
						page_count: 12,
						chunk_count: 34,
						status: "ok",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});
		await client.process(req);
		expect(seenUrl).toBe("http://ai.local/v1/documents:process");
	});

	it("baseUrl 末尾有多个 / 时也能正确处理", async () => {
		let seenUrl = "";
		const client = createDocumentsClient({
			baseUrl: "http://ai.local///",
			internalToken: "T",
			fetchImpl: fakeFetch((url) => {
				seenUrl = url;
				return new Response(
					JSON.stringify({
						upload_id: "U1",
						artifact_key: "artifact/U1.json",
						title: "某办法",
						page_count: 12,
						chunk_count: 34,
						status: "ok",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		});
		await client.process(req);
		expect(seenUrl).toBe("http://ai.local/v1/documents:process");
	});

	it("buildProcessRequestBody: corpusHint 缺省时不包含 corpus_hint 键", () => {
		const body = buildProcessRequestBody({
			objectKey: "upload/U1/a.pdf",
			uploadId: "U1",
			filename: "a.pdf",
		});
		expect("corpus_hint" in body).toBe(false);
		expect(body).toEqual({
			object_key: "upload/U1/a.pdf",
			upload_id: "U1",
			filename: "a.pdf",
		});
	});

	it("buildProcessRequestBody: corpusHint 传入时包含 corpus_hint 键", () => {
		const body = buildProcessRequestBody({
			objectKey: "upload/U1/a.pdf",
			uploadId: "U1",
			filename: "a.pdf",
			corpusHint: "external",
		});
		expect("corpus_hint" in body).toBe(true);
		expect(body).toEqual({
			object_key: "upload/U1/a.pdf",
			upload_id: "U1",
			filename: "a.pdf",
			corpus_hint: "external",
		});
	});

	it("title 非字符串时返回 null", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							title: 123,
							page_count: 12,
							chunk_count: 34,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.title).toBeNull();
	});

	it("title 为 undefined 时返回 null", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							page_count: 12,
							chunk_count: 34,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.title).toBeNull();
	});

	it("page_count 非数字时返回 null", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							title: "某办法",
							page_count: "twelve",
							chunk_count: 34,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.pageCount).toBeNull();
	});

	it("page_count 为 undefined 时返回 null", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							title: "某办法",
							chunk_count: 34,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.pageCount).toBeNull();
	});

	it("chunk_count 缺失时返回 0", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							title: "某办法",
							page_count: 12,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.chunkCount).toBe(0);
	});

	it("chunk_count 非数字时返回 0", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							title: "某办法",
							page_count: 12,
							chunk_count: "thirty-four",
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.chunkCount).toBe(0);
	});

	it("artifact_key 为空串时抛错", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "",
							title: "某办法",
							page_count: 12,
							chunk_count: 34,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		await expect(client.process(req)).rejects.toThrow(/artifact_key/);
	});

	it("upload_id 缺失时使用请求中的 uploadId", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							artifact_key: "artifact/U1.json",
							title: "某办法",
							page_count: 12,
							chunk_count: 34,
							status: "ok",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.uploadId).toBe("U1");
	});

	it("status 缺失时返回空串", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							upload_id: "U1",
							artifact_key: "artifact/U1.json",
							title: "某办法",
							page_count: 12,
							chunk_count: 34,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		});
		const got = await client.process(req);
		expect(got.status).toBe("");
	});

	it("非 2xx 时 message 包含响应体片段", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(() => new Response("error: invalid document format", { status: 400 })),
		});
		await expect(client.process(req)).rejects.toThrow(/error: invalid/);
	});

	it("fetch 返回非 JSON 响应时仍能报错含状态码", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(() => new Response("internal server error", { status: 500 })),
		});
		await expect(client.process(req)).rejects.toThrow(/500.*internal server error/);
	});

	it("2xx 但响应体不是合法 JSON 时抛错,message 含响应片段", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch(() => new Response("not json{invalid", { status: 200 })),
		});
		await expect(client.process(req)).rejects.toThrow(/documents:process 响应不是合法 JSON:not json/);
	});
});
