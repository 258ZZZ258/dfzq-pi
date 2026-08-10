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

/**
 * 终审 I5:`documents:process` 是同步解析 PDF 的端点,此前这里的 `fetch` **不传 signal、无超时**,
 * 只有 undici 默认的 300s headers timeout 兜着。而 `PolicyCompareRuntime` 的 `runTimeoutMs` 定时器
 * 触发时只调 `session.abort()`,打断不了这个 `fetch` —— 挂住时 `run()` 的 promise 永不 settle,
 * `RunManager` 的并发令牌被永久扣掉一个。
 */
describe("createDocumentsClient · 超时(终审 I5)", () => {
	/** 一个永不返回、只在收到 abort 时才 reject 的 fetch —— 模拟对面挂死。 */
	const hangingFetch = (): typeof fetch =>
		((_input: string | URL | Request, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
			})) as unknown as typeof fetch;

	it("请求带 AbortSignal —— 没有它,定时器再准也掐不断这次 fetch", async () => {
		let seenSignal: unknown;
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			fetchImpl: fakeFetch((_url, init) => {
				seenSignal = init.signal;
				return new Response(JSON.stringify({ artifact_key: "artifact/U1.json" }), { status: 200 });
			}),
		});
		await client.process(req);
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	it("对面挂住时按 timeoutMs 中断并响亮报错(不无限等待)", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			timeoutMs: 20,
			fetchImpl: hangingFetch(),
		});
		const error = await client.process(req).then(
			() => new Error("不该成功"),
			(e: unknown) => e as Error,
		);
		// 断言超时值本身也在信息里 —— 值班的人要能一眼看出是哪一道超时掐的
		expect(error.message).toContain("documents:process 超时");
		expect(error.message).toContain("20ms");
	});

	it("超时被如实报成超时,不退化成「响应不是合法 JSON」那类误导性信息", async () => {
		const client = createDocumentsClient({
			baseUrl: "http://ai.local",
			internalToken: "T",
			timeoutMs: 20,
			fetchImpl: hangingFetch(),
		});
		const error = await client.process(req).then(
			() => new Error("不该成功"),
			(e: unknown) => e as Error,
		);
		expect(error.message).toContain("超时");
		expect(error.message).not.toContain("不是合法 JSON");
	});
});
