import type { CoverageResult, VersionDiffResult } from "./types.ts";

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

export interface ExternalDocumentCatalogItem {
	logicalId: string;
	docVersionId: string;
	title: string;
	versionLabel: string;
	versionStatus: string;
	versionCode: string | null;
	versionDisplayName: string | null;
	revisionNo: number | null;
	docNumber: string | null;
	issueDate: string | null;
	effectiveDate: string | null;
	supersedesVersionId: string | null;
	sourceDocId: string | null;
}

export interface LibraryExternalDocument {
	uploadId: string;
	title: string;
	docNo?: string;
	clauses: Array<{
		seq: number;
		clausePath: string;
		text: string;
		pageStart?: number;
		pageEnd?: number;
	}>;
}

export type InternalDocumentCatalogItem = ExternalDocumentCatalogItem;
export type LibraryInternalDocument = LibraryExternalDocument;

export interface InternalReferenceVersionCheckRequest {
	docVersionId?: string;
	clauses?: Array<{ chunkId: string; clausePath: string | null; text: string }>;
	effectiveDateRange?: [string, string];
	permTags?: string[];
}

export interface VersionDiffRequest {
	newDocVersionId: string;
	oldDocVersionId: string;
	permTags?: string[];
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
	 * `fetch`。生产路径不传 `fetchImpl` 时用的是 Node 内置 `fetch`(undici),挂住不是真的永不
	 * settle —— undici 默认的 headersTimeout/bodyTimeout(各 300s)会兜底,但 300s 足以把 `run()`
	 * 的 promise 拖到远超 `runTimeoutMs` 之后才 settle;如果注入的是别的 `fetchImpl`(比如测试里的
	 * 假实现),这层 undici 保底也不存在,那就真的可能永不 settle。这里的 `timeoutMs` 才是唯一能
	 * 保证「不超过这个数」的那道闸 —— 挂住超时后 `RunManager` 的并发令牌会被扣掉一个,且不会自愈。
	 */
	timeoutMs?: number;
}

export interface DocumentsClient {
	process(req: ProcessDocumentRequest): Promise<ProcessDocumentResponse>;
	listExternalDocuments?(permTags?: string[], includeHistory?: boolean): Promise<ExternalDocumentCatalogItem[]>;
	getExternalDocument?(docVersionId: string, permTags?: string[]): Promise<LibraryExternalDocument>;
	listInternalDocuments?(permTags?: string[], includeHistory?: boolean): Promise<InternalDocumentCatalogItem[]>;
	getInternalDocument?(docVersionId: string, permTags?: string[]): Promise<LibraryInternalDocument>;
	checkInternalReferenceVersions?(req: InternalReferenceVersionCheckRequest): Promise<CoverageResult>;
	compareVersions?(req: VersionDiffRequest): Promise<VersionDiffResult>;
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
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const url = `${baseUrl}/v1/documents:process`;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;

	async function getJson(path: string): Promise<unknown> {
		const res = await doFetch(`${baseUrl}${path}`, {
			headers: { Accept: "application/json", "X-Internal-Token": options.internalToken },
		});
		const text = await res.text().catch(() => "");
		if (!res.ok) throw new Error(`documents library 返回 ${res.status}:${text.slice(0, 500)}`);
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`documents library 响应不是合法 JSON:${text.slice(0, 500)}`);
		}
	}

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
		async listExternalDocuments(permTags = [], includeHistory = false) {
			const query = new URLSearchParams();
			for (const tag of permTags) query.append("perm_tag", tag);
			if (includeHistory) query.set("include_history", "true");
			const suffix = query.toString() ? `?${query.toString()}` : "";
			const raw = await getJson(`/v1/library/external-documents${suffix}`);
			if (!Array.isArray(raw)) throw new Error("documents library 目录响应必须是数组");
			return raw.map((item) => {
				const row = item as Record<string, unknown>;
				return {
					logicalId: String(row.logical_id ?? ""),
					docVersionId: String(row.doc_version_id ?? ""),
					title: String(row.title ?? ""),
					versionLabel: String(row.version_label ?? "当前有效版本"),
					versionStatus: String(row.version_status ?? ""),
					versionCode: typeof row.version_code === "string" ? row.version_code : null,
					versionDisplayName: typeof row.version_display_name === "string" ? row.version_display_name : null,
					revisionNo: typeof row.revision_no === "number" ? row.revision_no : null,
					docNumber: typeof row.doc_number === "string" ? row.doc_number : null,
					issueDate: typeof row.issue_date === "string" ? row.issue_date : null,
					effectiveDate: typeof row.effective_date === "string" ? row.effective_date : null,
					supersedesVersionId: typeof row.supersedes_version_id === "string" ? row.supersedes_version_id : null,
					sourceDocId: typeof row.source_doc_id === "string" ? row.source_doc_id : null,
				};
			});
		},
		async getExternalDocument(docVersionId, permTags = []) {
			const query = new URLSearchParams();
			for (const tag of permTags) query.append("perm_tag", tag);
			const suffix = query.toString() ? `?${query.toString()}` : "";
			const raw = (await getJson(
				`/v1/library/external-documents/${encodeURIComponent(docVersionId)}${suffix}`,
			)) as Record<string, unknown>;
			if (!Array.isArray(raw.clauses)) throw new Error("documents library 文档响应缺少 clauses");
			return {
				uploadId: `library:${docVersionId}`,
				title: String(raw.title ?? docVersionId),
				docNo: typeof raw.doc_no === "string" ? raw.doc_no : undefined,
				clauses: raw.clauses.map((item) => {
					const clause = item as Record<string, unknown>;
					return {
						seq: Number(clause.seq ?? 0),
						clausePath: String(clause.clause_path ?? ""),
						text: String(clause.text ?? ""),
						pageStart: typeof clause.page_start === "number" ? clause.page_start : undefined,
						pageEnd: typeof clause.page_end === "number" ? clause.page_end : undefined,
					};
				}),
			};
		},
		async listInternalDocuments(permTags = [], includeHistory = false) {
			const query = new URLSearchParams();
			for (const tag of permTags) query.append("perm_tag", tag);
			if (includeHistory) query.set("include_history", "true");
			const suffix = query.toString() ? `?${query.toString()}` : "";
			const raw = await getJson(`/v1/library/internal-documents${suffix}`);
			if (!Array.isArray(raw)) throw new Error("documents library 内规目录响应必须是数组");
			return raw.map((item) => {
				const row = item as Record<string, unknown>;
				return {
					logicalId: String(row.logical_id ?? ""),
					docVersionId: String(row.doc_version_id ?? ""),
					title: String(row.title ?? ""),
					versionLabel: String(row.version_label ?? "当前有效版本"),
					versionStatus: String(row.version_status ?? ""),
					versionCode: typeof row.version_code === "string" ? row.version_code : null,
					versionDisplayName: typeof row.version_display_name === "string" ? row.version_display_name : null,
					revisionNo: typeof row.revision_no === "number" ? row.revision_no : null,
					docNumber: typeof row.doc_number === "string" ? row.doc_number : null,
					issueDate: typeof row.issue_date === "string" ? row.issue_date : null,
					effectiveDate: typeof row.effective_date === "string" ? row.effective_date : null,
					supersedesVersionId: typeof row.supersedes_version_id === "string" ? row.supersedes_version_id : null,
					sourceDocId: typeof row.source_doc_id === "string" ? row.source_doc_id : null,
				};
			});
		},
		async getInternalDocument(docVersionId, permTags = []) {
			const query = new URLSearchParams();
			for (const tag of permTags) query.append("perm_tag", tag);
			const suffix = query.toString() ? `?${query.toString()}` : "";
			const raw = (await getJson(
				`/v1/library/internal-documents/${encodeURIComponent(docVersionId)}${suffix}`,
			)) as Record<string, unknown>;
			if (!Array.isArray(raw.clauses)) throw new Error("documents library 内规文档响应缺少 clauses");
			return {
				uploadId: `library:${docVersionId}`,
				title: String(raw.title ?? docVersionId),
				docNo: typeof raw.doc_no === "string" ? raw.doc_no : undefined,
				clauses: raw.clauses.map((item) => {
					const clause = item as Record<string, unknown>;
					return {
						seq: Number(clause.seq ?? 0),
						clausePath: String(clause.clause_path ?? ""),
						text: String(clause.text ?? ""),
						pageStart: typeof clause.page_start === "number" ? clause.page_start : undefined,
						pageEnd: typeof clause.page_end === "number" ? clause.page_end : undefined,
					};
				}),
			};
		},
		async checkInternalReferenceVersions(req) {
			const body: Record<string, unknown> = { perm_tags: req.permTags ?? [] };
			if (req.docVersionId) body.doc_version_id = req.docVersionId;
			if (req.clauses) {
				body.clauses = req.clauses.map((clause) => ({
					chunk_id: clause.chunkId,
					clause_path: clause.clausePath,
					text: clause.text,
				}));
			}
			if (req.effectiveDateRange) {
				body.effective_from = req.effectiveDateRange[0];
				body.effective_to = req.effectiveDateRange[1];
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await doFetch(`${baseUrl}/v1/internal-reference-version-check`, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"content-type": "application/json",
						"X-Internal-Token": options.internalToken,
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				const text = await res.text();
				if (!res.ok) throw new Error(`internal reference check 返回 ${res.status}:${text.slice(0, 500)}`);
				try {
					return JSON.parse(text) as CoverageResult;
				} catch {
					throw new Error(`internal reference check 响应不是合法 JSON:${text.slice(0, 500)}`);
				}
			} catch (cause) {
				if (controller.signal.aborted) {
					throw new Error(`internal reference check 超时(${timeoutMs}ms)—— 已中断请求`);
				}
				throw cause;
			} finally {
				clearTimeout(timer);
			}
		},
		async compareVersions(req) {
			if (!req.newDocVersionId || !req.oldDocVersionId || req.newDocVersionId === req.oldDocVersionId) {
				throw new Error("版本差异比对需要两个不同的知识库版本");
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await doFetch(`${baseUrl}/v1/library/version-diff`, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"content-type": "application/json",
						"X-Internal-Token": options.internalToken,
					},
					body: JSON.stringify({
						new_doc_version_id: req.newDocVersionId,
						old_doc_version_id: req.oldDocVersionId,
						perm_tags: req.permTags ?? [],
					}),
					signal: controller.signal,
				});
				const text = await res.text();
				if (!res.ok) throw new Error(`version diff 返回 ${res.status}:${text.slice(0, 500)}`);
				let raw: Record<string, unknown>;
				try {
					raw = JSON.parse(text) as Record<string, unknown>;
				} catch {
					throw new Error(`version diff 响应不是合法 JSON:${text.slice(0, 500)}`);
				}
				if (raw.compare_type !== "version_diff" || !Array.isArray(raw.rows)) {
					throw new Error("version diff 响应不符合版本差异契约");
				}
				const document = (value: unknown) => {
					const item = value as Record<string, unknown>;
					return {
						docVersionId: String(item.doc_version_id ?? ""),
						title: String(item.title ?? ""),
						versionLabel: String(item.version_label ?? ""),
						versionStatus: String(item.version_status ?? ""),
						versionCode: typeof item.version_code === "string" ? item.version_code : null,
						versionDisplayName: typeof item.version_display_name === "string" ? item.version_display_name : null,
						revisionNo: typeof item.revision_no === "number" ? item.revision_no : null,
						issueDate: typeof item.issue_date === "string" ? item.issue_date : null,
						effectiveDate: typeof item.effective_date === "string" ? item.effective_date : null,
					};
				};
				const metrics = raw.metrics as Record<string, unknown>;
				return {
					compareType: "version_diff",
					corpusType: raw.corpus_type === "internal" ? "internal" : "external",
					logicalId: String(raw.logical_id ?? ""),
					newVersion: document(raw.new_version),
					oldVersion: document(raw.old_version),
					metrics: {
						added: Number(metrics?.added ?? 0),
						removed: Number(metrics?.removed ?? 0),
						changed: Number(metrics?.changed ?? 0),
						moved: Number(metrics?.moved ?? 0),
						total: Number(metrics?.total ?? 0),
					},
					rows: raw.rows.map((item, index) => {
						const row = item as Record<string, unknown>;
						const tabKey =
							row.tab_key === "added" || row.tab_key === "removed" || row.tab_key === "moved"
								? row.tab_key
								: "changed";
						return {
							index: Number(row.index ?? index + 1),
							tabKey,
							place: String(row.clause_path ?? "未标注条款"),
							oldPlace: typeof row.old_clause_path === "string" ? row.old_clause_path : undefined,
							newPlace: typeof row.new_clause_path === "string" ? row.new_clause_path : undefined,
							policyA: String(row.new_text ?? ""),
							policyB: String(row.old_text ?? ""),
							level:
								tabKey === "added"
									? "新增"
									: tabKey === "removed"
										? "删除"
										: tabKey === "moved"
											? "位置调整"
											: "修改",
							description:
								tabKey === "added"
									? "新版本新增条款"
									: tabKey === "removed"
										? "新版本删除条款"
										: tabKey === "moved"
											? `正文未变：${String(row.old_clause_path ?? "旧位置")} → ${String(row.new_clause_path ?? "新位置")}`
											: "新旧版本条款内容变更",
						};
					}),
					finish_reason: "stop",
				};
			} catch (cause) {
				if (controller.signal.aborted) throw new Error(`version diff 超时(${timeoutMs}ms)—— 已中断请求`);
				throw cause;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
