"""内规引用外规版本核查。

只处理内规条款正文里字面写出的 R4 跨文档引用。结果由引用表、版本链与条款原文
确定性组装，不用 LLM，也不把语义相似当成“引用”。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import or_, select

from common.pg_models import Chunk, ClauseReference, Document, DocVersion
from pipeline.chunking.ref_resolver import XRefHit, align_xref, extract_xrefs
from query.change.version_diff import diff_clauses


@dataclass(frozen=True)
class InternalClause:
    chunk_id: str
    clause_path: str | None
    text: str


@dataclass(frozen=True)
class ExplicitReference:
    reference_id: str
    internal_clause: InternalClause
    surface_text: str
    resolution_status: str
    cited_doc_version_id: str | None
    cited_clause_path_norm: str | None


def _allowed_tags(perm_tags: list[str]) -> list[str]:
    return sorted({"public", *[tag for tag in perm_tags if tag]})


def _version_label(version) -> str:
    version_date = version.issue_date or version.effective_date
    if version_date:
        return f"{version_date.year}版"
    return version.doc_number or version.doc_version_id


def _clause_text(pg, doc_version_id: str, clause_path_norm: str | None) -> str:
    if not clause_path_norm:
        return ""
    with pg.session() as session:
        rows = session.scalars(
            select(Chunk)
            .where(
                Chunk.doc_version_id == doc_version_id,
                Chunk.clause_path_norm == clause_path_norm,
                Chunk.is_parent.is_(False),
                Chunk.degraded.is_(False),
            )
            .order_by(Chunk.seq)
        ).all()
        return "\n".join(row.text for row in rows)


def _current_external_version(
    pg,
    cited_version,
    allowed_tags: list[str],
    effective_from: date | None,
    effective_to: date | None,
):
    with pg.session() as session:
        conditions = [
            DocVersion.logical_id == cited_version.logical_id,
            DocVersion.pipeline_status == "INDEXED",
            DocVersion.version_status.in_(["effective", "upcoming"]),
            DocVersion.perm_tag.in_(allowed_tags),
        ]
        if effective_from:
            conditions.append(or_(DocVersion.effective_date.is_(None), DocVersion.effective_date >= effective_from))
        if effective_to:
            conditions.append(or_(DocVersion.effective_date.is_(None), DocVersion.effective_date <= effective_to))
        return session.scalars(
            select(DocVersion)
            .where(*conditions)
            .order_by(
                DocVersion.effective_date.desc().nullslast(),
                DocVersion.issue_date.desc().nullslast(),
                DocVersion.doc_version_id.desc(),
            )
        ).first()


def _document_is_external(pg, doc_version_id: str, allowed_tags: list[str]):
    with pg.session() as session:
        row = session.execute(
            select(Document, DocVersion)
            .join(DocVersion, DocVersion.logical_id == Document.logical_id)
            .where(
                DocVersion.doc_version_id == doc_version_id,
                Document.corpus_type == "P-EXT",
                DocVersion.perm_tag.in_(allowed_tags),
            )
        ).first()
        return row


def load_library_internal_references(pg, doc_version_id: str, perm_tags: list[str]):
    """读取库内内规的 R4 引用；无权或不是内规时返回 ``None``。"""
    allowed = _allowed_tags(perm_tags)
    with pg.session() as session:
        source = session.execute(
            select(Document, DocVersion)
            .join(DocVersion, DocVersion.logical_id == Document.logical_id)
            .where(
                DocVersion.doc_version_id == doc_version_id,
                Document.corpus_type == "P-INT",
                DocVersion.pipeline_status.in_(["INDEXED", "EMBEDDING"]),
                DocVersion.perm_tag.in_(allowed),
            )
        ).first()
        if source is None:
            return None
        rows = session.execute(
            select(ClauseReference, Chunk)
            .join(Chunk, Chunk.chunk_id == ClauseReference.chunk_id)
            .where(
                ClauseReference.doc_version_id == doc_version_id,
                ClauseReference.ref_type == "R4",
                Chunk.is_parent.is_(False),
                Chunk.degraded.is_(False),
            )
            .order_by(Chunk.seq, ClauseReference.span_start, ClauseReference.ref_id)
        ).all()
        return [
            ExplicitReference(
                reference_id=str(ref.ref_id),
                internal_clause=InternalClause(chunk.chunk_id, chunk.clause_path, chunk.text),
                surface_text=ref.surface_text,
                resolution_status=ref.resolution_status,
                cited_doc_version_id=ref.target_doc_version_id,
                cited_clause_path_norm=ref.target_clause_path_norm,
            )
            for ref, chunk in rows
        ]


class _HistoricalLookup:
    """上传内规的 R4 解析：文号可命中历史版本，标题歧义时只接受单一逻辑文档。"""

    def __init__(self, pg, allowed_tags: list[str]) -> None:
        self.pg = pg
        self.allowed_tags = allowed_tags

    def resolve(self, doc_number: str | None, title: str | None) -> XRefHit:
        with self.pg.session() as session:
            query = (
                select(Document, DocVersion)
                .join(DocVersion, DocVersion.logical_id == Document.logical_id)
                .where(
                    Document.corpus_type == "P-EXT",
                    DocVersion.pipeline_status == "INDEXED",
                    DocVersion.perm_tag.in_(self.allowed_tags),
                )
            )
            if doc_number:
                rows = session.execute(query.where(DocVersion.doc_number == doc_number)).all()
            elif title:
                rows = session.execute(query.where(DocVersion.title == title)).all()
                logical_ids = {doc.logical_id for doc, _version in rows}
                if len(logical_ids) == 1 and rows:
                    rows = sorted(
                        rows,
                        key=lambda row: (
                            row[1].version_status == "effective",
                            row[1].effective_date or date.min,
                            row[1].issue_date or date.min,
                        ),
                        reverse=True,
                    )[:1]
            else:
                rows = []
            if len(rows) != 1:
                return XRefHit("multiple" if rows else "none", None, None, frozenset())
            _doc, version = rows[0]
            norms = frozenset(
                value
                for value in session.scalars(
                    select(Chunk.clause_path_norm).where(
                        Chunk.doc_version_id == version.doc_version_id,
                        Chunk.clause_path_norm.is_not(None),
                    )
                )
            )
            return XRefHit("single", version.doc_version_id, version.doc_number, norms)


def extract_uploaded_internal_references(pg, clauses: list[InternalClause], perm_tags: list[str]):
    lookup = _HistoricalLookup(pg, _allowed_tags(perm_tags))
    refs: list[ExplicitReference] = []
    for clause in clauses:
        for index, candidate in enumerate(extract_xrefs(clause.text, 0)):
            resolved = align_xref(candidate, lookup)
            refs.append(
                ExplicitReference(
                    reference_id=f"{clause.chunk_id}:{index}",
                    internal_clause=clause,
                    surface_text=resolved.surface_text,
                    resolution_status=resolved.resolution_status,
                    cited_doc_version_id=resolved.target_doc_version_id,
                    cited_clause_path_norm=resolved.target_clause_path_norm,
                )
            )
    return refs


def build_reference_version_result(
    pg,
    references: list[ExplicitReference],
    perm_tags: list[str],
    effective_from: date | None = None,
    effective_to: date | None = None,
):
    """显式引用 → 版本状态行表。只把异常引用放进 rows，当前引用进入 covered 指标。"""
    allowed = _allowed_tags(perm_tags)
    rows = []
    gaps = []
    covered = 0
    missing = 0
    conflict = 0
    unmatched = 0

    for ref in references:
        if ref.resolution_status != "resolved" or not ref.cited_doc_version_id:
            missing += 1
            rows.append(
                {
                    "index": len(rows) + 1,
                    "tabKey": "missing",
                    "conflictType": "引用未解析",
                    "externalClause": ref.surface_text,
                    "internalClause": ref.internal_clause.text,
                    "judgement": "无法定位引用外规",
                    "source": ref.surface_text,
                    "suggestion": "补充准确的外规名称、文号和条款号后重新核查。",
                    "basis": {
                        "internalChunkId": ref.internal_clause.chunk_id,
                        "internalSourceCode": None,
                        "externalClausePath": ref.cited_clause_path_norm,
                        "externalDocNo": None,
                        "matchKind": "exact",
                        "referenceId": ref.reference_id,
                        "referenceSurface": ref.surface_text,
                        "citedDocVersionId": ref.cited_doc_version_id,
                        "currentDocVersionId": None,
                        "changeKind": "unresolved",
                    },
                }
            )
            gaps.append(f"内规条款 {ref.internal_clause.chunk_id} 的引用未解析：{ref.surface_text}")
            continue

        target_row = _document_is_external(pg, ref.cited_doc_version_id, allowed)
        if target_row is None:
            unmatched += 1
            gaps.append(f"引用目标 {ref.cited_doc_version_id} 不是授权范围内的外规版本")
            continue
        _target_doc, cited = target_row
        current = _current_external_version(pg, cited, allowed, effective_from, effective_to)
        if current is None:
            unmatched += 1
            gaps.append(f"外规 {cited.title or cited.doc_version_id} 在指定生效日期区间内没有可核查版本")
            continue
        if current.doc_version_id == cited.doc_version_id:
            covered += 1
            continue

        conflict += 1
        old_text = _clause_text(pg, cited.doc_version_id, ref.cited_clause_path_norm)
        new_text = _clause_text(pg, current.doc_version_id, ref.cited_clause_path_norm)
        clause_changed = bool(ref.cited_clause_path_norm) and old_text != new_text
        if not ref.cited_clause_path_norm:
            with pg.session() as session:
                old_chunks = list(
                    session.scalars(
                        select(Chunk).where(
                            Chunk.doc_version_id == cited.doc_version_id,
                            Chunk.is_parent.is_(False),
                            Chunk.degraded.is_(False),
                            Chunk.clause_path_norm.is_not(None),
                        )
                    )
                )
                new_chunks = list(
                    session.scalars(
                        select(Chunk).where(
                            Chunk.doc_version_id == current.doc_version_id,
                            Chunk.is_parent.is_(False),
                            Chunk.degraded.is_(False),
                            Chunk.clause_path_norm.is_not(None),
                        )
                    )
                )
            clause_changed = bool(diff_clauses(old_chunks, new_chunks))

        cited_label = _version_label(cited)
        current_label = _version_label(current)
        rows.append(
            {
                "index": len(rows) + 1,
                "tabKey": "error",
                "conflictType": "引用条款已变更" if clause_changed else "引用外规版本已更新",
                "externalClause": new_text or f"{current.title or current.doc_version_id}（{current_label}）",
                "internalClause": ref.internal_clause.text,
                "judgement": f"内规仍引用 {cited_label}，当前版本为 {current_label}",
                "source": f"{cited.title or cited.doc_version_id}：{cited_label} → {current_label}",
                "suggestion": "复核该内规条款是否需要按外规新版本同步修订。",
                "basis": {
                    "internalChunkId": ref.internal_clause.chunk_id,
                    "internalSourceCode": None,
                    "externalClausePath": ref.cited_clause_path_norm,
                    "externalDocNo": current.doc_number,
                    "matchKind": "exact",
                    "referenceId": ref.reference_id,
                    "referenceSurface": ref.surface_text,
                    "citedDocVersionId": cited.doc_version_id,
                    "currentDocVersionId": current.doc_version_id,
                    "changeKind": "clause_changed" if clause_changed else "version_changed",
                },
            }
        )

    return {
        "compareType": "internal_to_external",
        "metrics": {
            "checked": len(references),
            "missing": missing,
            "conflict": conflict,
            "covered": covered,
            "unmatched": unmatched,
            "linked": 0,
        },
        "rows": rows,
        "gaps": gaps,
        "finish_reason": "stop",
    }
