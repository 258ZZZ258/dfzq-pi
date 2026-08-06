import type { ExternalClause, ExternalDocument } from "./types.ts";

/** 取一个对象的正文。抽成函数是为了让测试不必起 MinIO。 */
export type ObjectGetter = (bucket: string, key: string) => Promise<string>;

interface RawChunk {
	seq?: unknown;
	clause_path?: unknown;
	chunk_type?: unknown;
	text?: unknown;
	page_start?: unknown;
	page_end?: unknown;
	is_table?: unknown;
}

/**
 * `artifact/{upload_id}.json` → `ExternalDocument`。
 * 形状主本:dfzq-audit-ai `pipeline/pipeline/ondemand/artifact.py` 的 `UploadArtifact`。
 *
 * **只留 `chunk_type === "clause"` 且 `is_table !== true` 的块** —— 表格与目录块不参与条款级比对。
 */
export function parseArtifact(json: string): ExternalDocument {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(json) as Record<string, unknown>;
	} catch (cause) {
		throw new Error(`artifact 不是合法 JSON:${cause instanceof Error ? cause.message : String(cause)}`);
	}
	const chunks = raw.chunks;
	if (!Array.isArray(chunks)) {
		throw new Error("artifact 缺少 chunks 数组 —— 上游解析没产出结构化切块,不能继续");
	}
	const doc = (raw.doc ?? {}) as Record<string, unknown>;
	const clauses: ExternalClause[] = [];
	for (const item of chunks as RawChunk[]) {
		if (item.chunk_type !== "clause" || item.is_table === true) continue;
		if (typeof item.text !== "string" || item.text.trim() === "") continue;
		clauses.push({
			seq: typeof item.seq === "number" ? item.seq : clauses.length,
			clausePath: typeof item.clause_path === "string" ? item.clause_path : "",
			text: item.text,
			pageStart: typeof item.page_start === "number" ? item.page_start : undefined,
			pageEnd: typeof item.page_end === "number" ? item.page_end : undefined,
		});
	}
	// 整篇一个条款块都没有 ⇒ 后面阶段 4 必然零对齐、阶段 6 出一张空表。
	// 那看起来像「完全覆盖」,实则是解析失败 —— 必须响亮报错(不静默零结果)。
	if (clauses.length === 0) {
		throw new Error("artifact 里没有任何条款块(chunk_type=clause)—— 上传件解析结果不可用");
	}
	return {
		uploadId: String(raw.upload_id ?? ""),
		title: typeof doc.title === "string" ? doc.title : "",
		docNo: undefined,
		clauses,
	};
}

export interface ArtifactStore {
	fetch(artifactKey: string): Promise<ExternalDocument>;
}

export function createArtifactStore(opts: { bucket: string; get: ObjectGetter }): ArtifactStore {
	return {
		async fetch(artifactKey) {
			return parseArtifact(await opts.get(opts.bucket, artifactKey));
		},
	};
}

/**
 * 读完一个可异步迭代的流并按 utf8 拼成字符串。
 *
 * 抽成纯函数是因为它是纯逻辑,埋在 `createMinioObjectGetter` 里就只能靠真 MinIO 才能覆盖到。
 * 关键点: 必须先 `Buffer.concat` 再 `.toString("utf8")`,否则逐 chunk toString 会把跨界的多字节字符切坏。
 */
export async function readStreamToString(stream: AsyncIterable<unknown>): Promise<string> {
	const parts: Buffer[] = [];
	for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
	return Buffer.concat(parts).toString("utf8");
}

export interface MinioConfig {
	endPoint: string;
	port?: number;
	useSSL?: boolean;
	accessKey: string;
	secretKey: string;
}

/**
 * 真 MinIO 后端。凭证走 env,**绝不入库**(与 audit-ai 的 `object_store.py` 同款纪律)。
 *
 * ⚠️ **懒导入与安全不变量的测试覆盖**:
 * - `minio` SDK 懒导入(第 89 行的 `import("minio")`)—— 只有真正用 MinIO 的部署路径才需要它可用。
 *   懒导入本身**没有测试守护**,改动时需要人工留意是否仍然保持懒加载特性。
 * - 凭证 fail-closed(第 84-86 行)——  accessKey/secretKey 为空时立即抛错,有测试守护。
 */
export function createMinioObjectGetter(cfg: MinioConfig): ObjectGetter {
	if (!cfg.accessKey || !cfg.secretKey) {
		throw new Error("createMinioObjectGetter: accessKey/secretKey 为空 —— 拒绝构造(fail-closed)");
	}
	let clientPromise: Promise<{ getObject: (b: string, k: string) => Promise<NodeJS.ReadableStream> }> | undefined;
	const client = async () => {
		if (!clientPromise) {
			// 懒导入:只在第一次调用 getObject 时才触发 import("minio")
			clientPromise = import("minio").then(
				(m) =>
					new m.Client({
						endPoint: cfg.endPoint,
						port: cfg.port,
						useSSL: cfg.useSSL ?? false,
						accessKey: cfg.accessKey,
						secretKey: cfg.secretKey,
					}) as unknown as { getObject: (b: string, k: string) => Promise<NodeJS.ReadableStream> },
			);
		}
		return clientPromise;
	};
	return async (bucket, key) => {
		const stream = await (await client()).getObject(bucket, key);
		return readStreamToString(stream);
	};
}
