"""PG 外规查询:``case_ref_align.RegLookup`` 的生产实现(零 LLM)。

从 case_l2 移出——case_l2(LLM 案例富集)整段移除后,``PgRegLookup`` 是纯 PG 工具,**preseg
结构化案例引用对齐仍用**(``cases_ingest.align_cited(cited, PgRegLookup(db))``),故独立保留于此。
"""

from __future__ import annotations

from sqlalchemy import select

from common.pg_models import Chunk, Document, DocVersion
from pipeline.meta.case_ref_align import RegDoc


class PgRegLookup:
    """生产外规查询(``case_ref_align.RegLookup`` 实现):PG 按文号 / 标题命中 effective **外规
    (P-EXT)**,聚合其全部 chunk 的 ``clause_path_norm`` 供超界校验。

    **corpus 限定 P-EXT**:案例引用的是外规(§9「引用外规条款」)。若不限语料,同文号 / 同标题的
    内规(P-INT)或案例(P-CASE)会被误取,把其 chunk 当外规条款落进 ``cited_regulations``,污染
    query 案例反查 → 故 join ``Document`` 钉死 ``corpus_type="P-EXT"``。
    """

    def __init__(self, db) -> None:
        self._db = db

    @staticmethod
    def _find_ext(s, predicate) -> DocVersion | None:
        """按 predicate 命中 effective 的 **P-EXT** doc_version(非外规即便文号/标题撞也不取)。"""
        return s.scalars(
            select(DocVersion)
            .join(Document, DocVersion.logical_id == Document.logical_id)
            .where(
                predicate,
                DocVersion.version_status == "effective",
                Document.corpus_type == "P-EXT",
            )
        ).first()

    def resolve_exact(self, source_code: str) -> dict | None:
        """CP-010 精确桥接:源条款锚 ``LAW_CONTENT.CODE`` → 命中 chunk 的
        ``{doc_no, clause_path_norm, title}``。

        限 effective **P-EXT**(与 ``find`` 同语义:案例引用外规,勿误取内规/案例 chunk)。
        ``doc_no``/``clause_path_norm`` 取自**同一 chunk 及其 doc_version**——与 query 侧对该条款
        算出的 ``norm_ref`` 键逐位一致,桥接确定性点亮(替代 fuzzy,消除 ``ref_unresolved`` 假阴)。
        源块超预算二次切分时多 chunk 同 ``source_code``/同 norm,取任一(``first``)即可。
        未命中(锚未入库/非 effective P-EXT)→ None,调用方回落 fuzzy。
        """
        with self._db.session() as s:
            row = s.execute(
                select(DocVersion.doc_number, Chunk.clause_path_norm, DocVersion.title)
                .join(Chunk, Chunk.doc_version_id == DocVersion.doc_version_id)
                .join(Document, DocVersion.logical_id == Document.logical_id)
                .where(
                    Chunk.source_code == source_code,
                    DocVersion.version_status == "effective",
                    Document.corpus_type == "P-EXT",
                )
            ).first()
        if row is None:
            return None
        return {"doc_no": row.doc_number, "clause_path_norm": row.clause_path_norm,
                "title": row.title}

    def find(self, doc_number: str | None, title: str | None) -> RegDoc | None:
        with self._db.session() as s:
            dv = self._find_ext(s, DocVersion.doc_number == doc_number) if doc_number else None
            if dv is None and title:  # 文号未命中 → 标题精确兜底(仍限 P-EXT)
                dv = self._find_ext(s, DocVersion.title == title)
            if dv is None:
                return None
            norms = frozenset(
                n
                for n in s.scalars(
                    select(Chunk.clause_path_norm).where(
                        Chunk.doc_version_id == dv.doc_version_id,
                        Chunk.clause_path_norm.is_not(None),
                    )
                )
            )
            return RegDoc(
                doc_version_id=dv.doc_version_id, doc_number=dv.doc_number, clause_norms=norms
            )
