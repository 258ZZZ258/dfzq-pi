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

/** `documents:process` 的默认超时。该端点同步解析 PDF,给得比常规 HTTP 调用宽。 */
export const DEFAULT_PROCESS_TIMEOUT_MS = 600_000;

export interface DocumentsClientOptions {
	baseUrl: string;
	/** `X-Internal-Token`。**空串即拒绝构造** —— 与边界契约的 fail-closed 同款。 */
	internalToken: string;
	fetchImpl?: typeof fetch;
	/**
	 * 单次 `process()` 的挂钟上限,缺省 `DEFAULT_PROCESS_TIMEOUT_MS`。
	 *
	 * 🔴 这不是可选的加固,是 `PolicyCompareRuntime` 那条 `runTimeoutMs` 定时器兜不住的洞:
	 * 那个定时器触发时只调 `session.abort()`,打断得了在飞的 `session.prompt()`,打断不了这里的
	 * `fetch`。不传 `signal` 时挂住的 `fetch` 会让 `run()` 的 promise 永不 settle,`RunManager`
	 * 的并发令牌被永久扣掉一个 —— 一次挂死就少一个并发额度,且不会自愈。
	 */
	timeoutMs?: number;
}

export interface DocumentsClient {
	process(req: ProcessDocumentRequest): Promise<ProcessDocumentResponse>;
}

/** 请求体字段名映射。抽成纯函数是因为「corpusHint 缺省时不放这个键」这条契约
 *  在 fetch 边界上观测不到 —— JSON.stringify 会丢弃 undefined 值的键,两种实现
 *  序列化后完全相同。只有直接断言这个对象才能锁住它。 */
export function buildProcessRequestBody(req: ProcessDocumentRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		object_key: req.objectKey,
		upload_id: req.uploadId,
		filename: req.filename,
	};
	if (req.corpusHint !== undefined) body.corpus_hint = req.corpusHint;
	return body;
}

export function createDocumentsClient(options: DocumentsClientOptions): DocumentsClient {
	// env 未配就拒绝构造,不留一个「跑起来才发现没鉴权」的运行期洞。
	if (!options.internalToken) {
		throw new Error("createDocumentsClient: internalToken 为空 —— 鉴权未配置,拒绝构造(fail-closed)");
	}
	const doFetch = options.fetchImpl ?? fetch;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/documents:process`;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;

	return {
		async process(req) {
			const body = buildProcessRequestBody(req);

			// 自己造 AbortController 而不是用 `AbortSignal.timeout()`:超时后要能区分「是我们主动
			// 掐的」与「对面主动断的」,前者给一条带 timeoutMs 的诊断信息。定时器覆盖到**读完响应体**
			// 为止 —— `fetch` 在响应头到达时就 resolve 了,body 流照样可以随后挂住。
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			const timedOut = () => new Error(`documents:process 超时(${timeoutMs}ms)—— 已中断请求,不再无限等待挂住的上游`);
			try {
				let res: Response;
				try {
					res = await doFetch(url, {
						method: "POST",
						headers: { "content-type": "application/json", "X-Internal-Token": options.internalToken },
						body: JSON.stringify(body),
						signal: controller.signal,
					});
				} catch (cause) {
					throw controller.signal.aborted ? timedOut() : cause;
				}
				if (!res.ok) {
					const text = await res.text().catch(() => "");
					throw new Error(`documents:process 返回 ${res.status}:${text.slice(0, 500)}`);
				}
				const text = await res.text().catch(() => "");
				// 读 body 期间被掐时 `.catch(() => "")` 会把它变成空串,再往下会误报成「响应不是合法
				// JSON」—— 超时要如实说成超时。
				if (controller.signal.aborted) throw timedOut();
				let raw: Record<string, unknown>;
				try {
					raw = JSON.parse(text) as Record<string, unknown>;
				} catch {
					throw new Error(`documents:process 响应不是合法 JSON:${text.slice(0, 500)}`);
				}
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
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
