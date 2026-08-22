/**
 * 制度比对 · 覆盖度引擎的阶段间形状。
 *
 * 六个阶段的数据流:
 *   阶段 1 → ExternalClause[]        (上传外规解析出的条款)
 *   阶段 2 → InternalObligation[]    (库内内规的义务条款)
 *   阶段 3 → SourceLawResolution[]   (内规条款 → 它衍生自的外规条款标识)
 *   阶段 4 → { pairs, unmatched }    (对齐结果)
 *   阶段 5 → Verdict[]               (模型判定,只有四个字段)
 *   阶段 6 → CoverageResult          (行表)
 */

/** 阶段 1:上传件解析出的一条外规条款。字段名照 audit-ai 的 `UploadArtifact.chunks[]`。 */
export interface ExternalClause {
	seq: number;
	clausePath: string;
	text: string;
	pageStart?: number;
	pageEnd?: number;
}

/** 阶段 1 的完整产物。 */
export interface ExternalDocument {
	uploadId: string;
	title: string;
	docNo?: string;
	clauses: ExternalClause[];
}

/** 阶段 2:库内一条内规义务条款。字段名照 M1 `list_internal_obligations` 的返回。 */
export interface InternalObligation {
	chunkId: string;
	clausePath: string | null;
	docTitle: string | null;
	docNo: string | null;
	deonticType: "obligation" | "prohibition" | "command";
	evidence: string | null;
	text: string;
	sourceCode: string | null;
}

/** 阶段 3:一条内规条款衍生自的某条外规条款的标识(**只有标识,没有正文**)。 */
export interface SourceLawRef {
	docNo: string | null;
	docTitle: string | null;
	clausePath: string | null;
	sourceCode: string | null;
}

export interface SourceLawResolution {
	chunkId: string;
	sourceLaws: SourceLawRef[];
}

/** 阶段 4:对上号的一对。`matchKind` 见规格 §3.3。 */
export interface ClausePair {
	externalClause: ExternalClause;
	internalObligation: InternalObligation;
	matchKind: "exact" | "normalized" | "doc_level" | "semantic_retrieval";
}

export interface UnmatchedObligation {
	internalChunkId: string;
	reason: string;
}

export interface AlignmentResult {
	pairs: ClausePair[];
	unmatched: UnmatchedObligation[];
	/** 批量检索路径以外规条款为核查单位；空候选和单条检索失败不能静默丢失。 */
	uncoveredExternalClauses?: Array<{
		externalClause: ExternalClause;
		reason: "no_internal_candidate" | "retrieval_failed";
	}>;
	/** 内规→外规批量检索中没有外规候选的待核查内规条款。
	 * 不能只留 chunkId：结果页需要展示真实内规原文，且必须明确说明外规侧未命中。 */
	uncoveredInternalClauses?: Array<{
		internalObligation: InternalObligation;
		reason: "no_external_candidate" | "external_retrieval_failed";
	}>;
	countBy?: "internal" | "external";
}

/** 阶段 5:模型对一对的判定。**模型只产这四个字段**,正文一概不产。 */
export interface Verdict {
	pairIndex: number;
	state: "covered" | "partial" | "missing" | "conflict";
	gap?: string;
	suggestion?: string;
	conflictType?: string;
}

/** 阶段 6 输出的一行。形状对齐 `Java对接协议` §9.2 的 ExternalCompareResultPayload.rows[]。 */
export interface CoverageRow {
	index: number;
	tabKey: "missing" | "error";
	conflictType: string;
	externalClause: string;
	internalClause: string;
	judgement: string;
	source: string;
	suggestion: string;
	basis: {
		internalChunkId: string;
		internalSourceCode: string | null;
		externalClausePath: string | null;
		externalDocNo: string | null;
		matchKind: "exact" | "normalized" | "doc_level" | "semantic_retrieval";
		referenceId?: string;
		referenceSurface?: string;
		citedDocVersionId?: string | null;
		currentDocVersionId?: string | null;
		changeKind?: "unresolved" | "version_changed" | "clause_changed";
	};
}

export interface CoverageMetrics {
	checked: number;
	missing: number;
	conflict: number;
	covered: number;
	unmatched: number;
	linked: number;
}

export interface LinkedDetailItem {
	title: string;
	content: string;
	sourceId?: string | null;
	sourceType?: "external_clause" | "internal_clause" | "audit_rule" | "check_point";
}

export interface CoverageResult {
	compareType: "external_to_internal" | "internal_to_external";
	metrics: CoverageMetrics;
	rows: CoverageRow[];
	linkedDetail?: LinkedDetailItem[];
	gaps?: string[];
	finish_reason: "stop" | "refused";
}

/** `POST /runs` 的 `payload`(覆盖度引擎)。形状校验见 runtime.ts 的 parsePayload。 */
export interface CoveragePayload {
	direction: "external_to_internal" | "internal_to_external";
	external?:
		| { source: "upload"; objectKey: string; uploadId: string; filename: string }
		| { source: "library"; docVersionId: string };
	internal?:
		| { source: "upload"; objectKey: string; uploadId: string; filename: string }
		| { source: "library"; docVersionId: string };
	scope: {
		organizations?: string[];
		bizDomains?: string[];
		chapters?: string[];
		effectiveDateRange?: [string, string];
	};
	outputTypes?: string[];
}

/** 同一逻辑制度的新旧版本条款差异。此路径不使用模型或 MCP。 */
export interface VersionDiffPayload {
	newDocVersionId: string;
	oldDocVersionId: string;
}

export interface VersionDiffDocument {
	docVersionId: string;
	title: string;
	versionLabel: string;
	versionStatus: string;
	versionCode?: string | null;
	versionDisplayName?: string | null;
	revisionNo?: number | null;
	issueDate?: string | null;
	effectiveDate?: string | null;
}

export interface VersionDiffRow {
	index: number;
	tabKey: "added" | "removed" | "changed" | "moved";
	place: string;
	oldPlace?: string;
	newPlace?: string;
	policyA: string;
	policyB: string;
	level: "新增" | "删除" | "修改" | "位置调整";
	description: string;
}

export interface VersionDiffResult {
	compareType: "version_diff";
	corpusType: "internal" | "external";
	logicalId: string;
	newVersion: VersionDiffDocument;
	oldVersion: VersionDiffDocument;
	metrics: { added: number; removed: number; changed: number; moved: number; total: number };
	rows: VersionDiffRow[];
	finish_reason: "stop";
}
