import { randomUUID } from "node:crypto";
import type { RuntimeSpec } from "../../spec/types.ts";
import type { RunOptions, RunResult, Runtime, RuntimeEvent } from "../contract.ts";
import type { InlinePolicyDocument, VersionDiffPayload, VersionDiffResult, VersionDiffRow } from "./types.ts";

export interface VersionDiffRuntimeOptions {
	spec: RuntimeSpec;
	payload: unknown;
}

export function parseVersionDiffPayload(raw: unknown): VersionDiffPayload {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("payload 必须是 JSON 对象");
	}
	const payload = raw as Record<string, unknown>;
	const corpusType = payload.corpusType;
	if (corpusType !== "internal" && corpusType !== "external") {
		throw new Error("payload.corpusType 仅支持 internal 或 external");
	}
	const newDocument = parseInlineDocument(payload.newDocument, "payload.newDocument");
	const oldDocument = parseInlineDocument(payload.oldDocument, "payload.oldDocument");
	if (newDocument.documentId === oldDocument.documentId) {
		throw new Error("payload.newDocument 与 oldDocument 必须是不同版本");
	}
	if (!newDocument.logicalId || !oldDocument.logicalId || newDocument.logicalId !== oldDocument.logicalId) {
		throw new Error("payload 新旧版本必须属于同一制度版本链");
	}
	return { corpusType, newDocument, oldDocument };
}

/**
 * 同一逻辑制度的版本 diff 不调用模型或知识库目录：Java 从主库下传两份标准化条款，
 * runtime 只做确定性对齐、进度事件和统一的 `/runs` 输出外壳。
 */
export function createVersionDiffRuntime(options: VersionDiffRuntimeOptions): Runtime {
	const payload = parseVersionDiffPayload(options.payload);
	const id = randomUUID();
	const sessionId = `policy-version-diff-${id}`;
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let running: Promise<RunResult> | undefined;
	let aborted = false;
	let disposed = false;
	let lastActiveAt = Date.now();
	let seq = 0;

	function emit(runId: string, type: string, payloadOut: unknown): void {
		for (const listener of listeners) {
			listener({ runId, specId: options.spec.id, seq: ++seq, ts: Date.now(), type, payload: payloadOut });
		}
	}

	return {
		id,
		specId: options.spec.id,
		sessionId,
		async run(_input: string, runOptions: RunOptions = {}): Promise<RunResult> {
			if (disposed) throw new Error("VersionDiffRuntime 已释放");
			if (running) throw new Error("VersionDiffRuntime 正在运行");
			aborted = false;
			const runId = runOptions.runId ?? randomUUID();
			const startedAt = Date.now();
			lastActiveAt = startedAt;
			running = (async () => {
				emit(runId, "compare_stage", { stage: "loading_versions", percent: 20, message: "正在对齐新旧版本条款" });
				try {
					const answer = compareInlineDocuments(payload.corpusType, payload.newDocument, payload.oldDocument);
					if (aborted) {
						return terminal(runId, "aborted", startedAt, "版本差异比对已取消");
					}
					emit(runId, "compare_stage", { stage: "assembling", percent: 100, message: "已完成条款差异汇总" });
					return {
						runId,
						specId: options.spec.id,
						status: "completed",
						output: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
						turns: 0,
						durationMs: Date.now() - startedAt,
						judgeAttempts: {},
						answer,
					};
				} catch (cause) {
					return terminal(runId, "error", startedAt, cause instanceof Error ? cause.message : String(cause));
				} finally {
					lastActiveAt = Date.now();
				}
			})();
			try {
				return await running;
			} finally {
				running = undefined;
			}
		},
		async steer(): Promise<void> {
			throw new Error("VersionDiffRuntime 不支持 steer(确定性工作流无插话语义)");
		},
		async followUp(): Promise<void> {
			throw new Error("VersionDiffRuntime 不支持 followUp(确定性工作流无插话语义)");
		},
		async abort(): Promise<void> {
			aborted = true;
		},
		async waitForIdle(): Promise<void> {
			if (running) await running;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get isIdle() {
			return running === undefined;
		},
		get lastActiveAt() {
			return lastActiveAt;
		},
		snapshot() {
			return { sessionId };
		},
		async dispose(): Promise<void> {
			disposed = true;
			listeners.clear();
		},
	};
}

function parseInlineDocument(raw: unknown, path: string): InlinePolicyDocument {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} 必须是文档对象`);
	const document = raw as Record<string, unknown>;
	if (typeof document.documentId !== "string" || document.documentId === "")
		throw new Error(`${path}.documentId 必填`);
	if (typeof document.logicalId !== "string" || document.logicalId === "") throw new Error(`${path}.logicalId 必填`);
	if (typeof document.title !== "string" || document.title === "") throw new Error(`${path}.title 必填`);
	if (!Array.isArray(document.clauses) || document.clauses.length < 1 || document.clauses.length > 800) {
		throw new Error(`${path}.clauses 必须包含 1 至 800 条条款`);
	}
	const seen = new Set<number>();
	return {
		documentId: document.documentId,
		logicalId: document.logicalId,
		title: document.title,
		...(typeof document.docNo === "string" && document.docNo !== "" ? { docNo: document.docNo } : {}),
		...(typeof document.issueDate === "string" && document.issueDate !== "" ? { issueDate: document.issueDate } : {}),
		clauses: document.clauses.map((rawClause, index) => {
			if (typeof rawClause !== "object" || rawClause === null || Array.isArray(rawClause)) {
				throw new Error(`${path}.clauses[${index}] 必须是条款对象`);
			}
			const clause = rawClause as Record<string, unknown>;
			if (
				typeof clause.seq !== "number" ||
				!Number.isInteger(clause.seq) ||
				clause.seq < 0 ||
				seen.has(clause.seq)
			) {
				throw new Error(`${path}.clauses[${index}].seq 必须唯一`);
			}
			if (typeof clause.clausePath !== "string" || clause.clausePath === "")
				throw new Error(`${path}.clauses[${index}].clausePath 必填`);
			if (typeof clause.text !== "string" || clause.text === "")
				throw new Error(`${path}.clauses[${index}].text 必填`);
			seen.add(clause.seq);
			return { seq: clause.seq, clausePath: clause.clausePath, text: clause.text };
		}),
	};
}

function compareInlineDocuments(
	corpusType: "internal" | "external",
	newDocument: InlinePolicyDocument,
	oldDocument: InlinePolicyDocument,
): VersionDiffResult {
	const oldByPath = new Map(oldDocument.clauses.map((clause) => [clause.clausePath, clause]));
	const unmatchedOld = new Map(oldDocument.clauses.map((clause) => [clause.seq, clause]));
	const rows: VersionDiffRow[] = [];
	for (const newClause of newDocument.clauses) {
		const samePlaceOld = oldByPath.get(newClause.clausePath);
		if (samePlaceOld) {
			unmatchedOld.delete(samePlaceOld.seq);
			if (normalizedBody(newClause.text) !== normalizedBody(samePlaceOld.text)) {
				rows.push(
					row(
						rows.length + 1,
						"changed",
						newClause.clausePath,
						samePlaceOld.clausePath,
						newClause.text,
						samePlaceOld.text,
						"修改",
						"新旧版本条款内容变更",
					),
				);
			}
			continue;
		}
		const movedOld = [...unmatchedOld.values()].find(
			(clause) => normalizedBody(clause.text) === normalizedBody(newClause.text),
		);
		if (movedOld) {
			unmatchedOld.delete(movedOld.seq);
			rows.push(
				row(
					rows.length + 1,
					"moved",
					newClause.clausePath,
					movedOld.clausePath,
					newClause.text,
					movedOld.text,
					"位置调整",
					`正文未变：${movedOld.clausePath} → ${newClause.clausePath}`,
				),
			);
		} else {
			rows.push(
				row(
					rows.length + 1,
					"added",
					newClause.clausePath,
					undefined,
					newClause.text,
					"",
					"新增",
					"新版本新增条款",
				),
			);
		}
	}
	for (const oldClause of unmatchedOld.values()) {
		rows.push(
			row(
				rows.length + 1,
				"removed",
				oldClause.clausePath,
				oldClause.clausePath,
				"",
				oldClause.text,
				"删除",
				"旧版本删除条款",
			),
		);
	}
	const metrics = {
		added: rows.filter((item) => item.tabKey === "added").length,
		removed: rows.filter((item) => item.tabKey === "removed").length,
		changed: rows.filter((item) => item.tabKey === "changed").length,
		moved: rows.filter((item) => item.tabKey === "moved").length,
		total: rows.length,
	};
	return {
		compareType: "version_diff",
		corpusType,
		logicalId: newDocument.logicalId ?? newDocument.documentId,
		newVersion: versionMetadata(newDocument, "effective"),
		oldVersion: versionMetadata(oldDocument, "superseded"),
		metrics,
		rows,
		finish_reason: "stop",
	};
}

function versionMetadata(document: InlinePolicyDocument, versionStatus: "effective" | "superseded") {
	return {
		docVersionId: document.documentId,
		title: document.title,
		versionLabel: document.issueDate ? `发布日期：${document.issueDate}` : "发布日期未维护",
		versionStatus,
		issueDate: document.issueDate ?? null,
	};
}

function normalizedBody(text: string): string {
	return text
		.replace(/^第[一二三四五六七八九十百千万零〇0-9]+条(?:之[一二三四五六七八九十百千万零〇0-9]+)?\s*/, "")
		.replace(/[\s\p{P}]/gu, "");
}

function row(
	index: number,
	tabKey: VersionDiffRow["tabKey"],
	place: string,
	oldPlace: string | undefined,
	policyA: string,
	policyB: string,
	level: VersionDiffRow["level"],
	description: string,
): VersionDiffRow {
	return {
		index,
		tabKey,
		place,
		...(oldPlace ? { oldPlace, newPlace: place } : {}),
		policyA,
		policyB,
		level,
		description,
	};
}

function terminal(runId: string, status: "aborted" | "error", startedAt: number, errorMessage: string): RunResult {
	return {
		runId,
		specId: "policy-compare-version-diff",
		status,
		errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		turns: 0,
		durationMs: Date.now() - startedAt,
		judgeAttempts: {},
	};
}
