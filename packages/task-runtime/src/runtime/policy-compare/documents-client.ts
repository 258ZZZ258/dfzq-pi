/**
 * audit-ai 的 `POST /v1/documents:process` 客户端。
 * 契约主本:dfzq-audit-ai `docs/upload-processing-docs/SPEC-UPLOAD-PROCESSING.md` §5.1。
 *
 * ⚠ 该端点在 audit-ai 侧**尚未实现**(规格 §5.0)。本模块可以先落地并单测,
 * 端到端联调要等对面上线。
 */

export interface ProcessDocumentRequest {
	objectKey: string;
	uploadId: string;
	filename: string;
	/** internal | external | qa | case;缺省走通用条款树。 */
	corpusHint?: string;
}

export interface ProcessDocumentResponse {
	uploadId: string;
	artifactKey: string;
	title: string | null;
	pageCount: number | null;
	chunkCount: number;
	status: string;
}

export interface DocumentsClientOptions {
	baseUrl: string;
	/** `X-Internal-Token`。**空串即拒绝构造** —— 与边界契约的 fail-closed 同款。 */
	internalToken: string;
	fetchImpl?: typeof fetch;
}

export interface DocumentsClient {
	process(req: ProcessDocumentRequest): Promise<ProcessDocumentResponse>;
}

export function createDocumentsClient(options: DocumentsClientOptions): DocumentsClient {
	// env 未配就拒绝构造,不留一个「跑起来才发现没鉴权」的运行期洞。
	if (!options.internalToken) {
		throw new Error("createDocumentsClient: internalToken 为空 —— 鉴权未配置,拒绝构造(fail-closed)");
	}
	const doFetch = options.fetchImpl ?? fetch;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/documents:process`;

	return {
		async process(req) {
			const body: Record<string, unknown> = {
				object_key: req.objectKey,
				upload_id: req.uploadId,
				filename: req.filename,
			};
			if (req.corpusHint !== undefined) body.corpus_hint = req.corpusHint;

			const res = await doFetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", "X-Internal-Token": options.internalToken },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`documents:process 返回 ${res.status}:${text.slice(0, 500)}`);
			}
			const raw = (await res.json()) as Record<string, unknown>;
			// artifact_key 是下一步取产物的唯一凭据,缺了就没法继续 —— 响亮报错,
			// 不返回一个 artifactKey 为 undefined 的半截结果让阶段 1 后面才炸。
			if (typeof raw.artifact_key !== "string" || raw.artifact_key === "") {
				throw new Error(`documents:process 响应缺少 artifact_key:${JSON.stringify(raw).slice(0, 500)}`);
			}
			return {
				uploadId: String(raw.upload_id ?? req.uploadId),
				artifactKey: raw.artifact_key,
				title: typeof raw.title === "string" ? raw.title : null,
				pageCount: typeof raw.page_count === "number" ? raw.page_count : null,
				chunkCount: typeof raw.chunk_count === "number" ? raw.chunk_count : 0,
				status: String(raw.status ?? ""),
			};
		},
	};
}
