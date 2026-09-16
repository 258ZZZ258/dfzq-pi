"""制度比对 M2:在本 run 的 M1 结果集内反查外规来源。"""

from __future__ import annotations

from typing import Any

import mcp.types as t
from sqlalchemy import and_, select
from sqlalchemy.orm import aliased

from common.pg_models import Chunk, ClauseReference, Document, DocVersion
from query.mcp.scope import AuthScope, ScopeError

TOOL = t.Tool(
    name="resolve_source_law",
    description=(
        "反查内规义务条款对应的外规来源。只接受本 run 由 "
        "list_internal_obligations 返回的 chunk_id；"
        "优先返回权威 R4 映射。覆盖核查显式传入 target_document 时，对尚无 R4 映射的条款"
        "返回可审计的文档级候选，交由后续模型判定。"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "chunk_ids": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 0,
                "maxItems": 500,
            },
            "target_document": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "doc_no": {"type": ["string", "null"]},
                },
                "required": ["title"],
                "additionalProperties": False,
            },
        },
        "required": ["chunk_ids"],
        "additionalProperties": False,
    },
)


def _validate(arguments: dict) -> tuple[list[str], dict[str, str | None] | None]:
    raw_ids = arguments.get("chunk_ids")
    if (
        not isinstance(raw_ids, list)
        or not 0 <= len(raw_ids) <= 500
        or not all(isinstance(v, str) and v.strip() for v in raw_ids)
    ):
        raise ScopeError(
            -32602, "invalid parameter: chunk_ids must contain at most 500 non-empty strings"
        )
    chunk_ids = list(dict.fromkeys(v.strip() for v in raw_ids))

    target = arguments.get("target_document")
    if target is None:
        return chunk_ids, None
    if not isinstance(target, dict):
        raise ScopeError(-32602, "invalid parameter: target_document must be an object")
    title = target.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ScopeError(
            -32602, "invalid parameter: target_document.title must be a non-empty string"
        )
    doc_no = target.get("doc_no")
    if doc_no is not None and (not isinstance(doc_no, str) or not doc_no.strip()):
        raise ScopeError(
            -32602, "invalid parameter: target_document.doc_no must be a string or null"
        )
    return chunk_ids, {"title": title.strip(), "doc_no": doc_no.strip() if doc_no else None}


def _load_source_laws(pg, chunk_ids: list[str]) -> dict[str, Any]:
    target_version = aliased(DocVersion)
    target_document = aliased(Document)
    target_chunk = aliased(Chunk)
    with pg.session() as session:
        existing = set(
            session.scalars(select(Chunk.chunk_id).where(Chunk.chunk_id.in_(chunk_ids))).all()
        )
        stmt = (
            select(
                ClauseReference.chunk_id,
                target_version.doc_number,
                target_version.title,
                target_document.title,
                ClauseReference.target_clause_path_norm,
                target_chunk.source_code,
            )
            .join(
                target_version,
                target_version.doc_version_id == ClauseReference.target_doc_version_id,
            )
            .join(target_document, target_document.logical_id == target_version.logical_id)
            .outerjoin(
                target_chunk,
                and_(
                    target_chunk.doc_version_id == target_version.doc_version_id,
                    target_chunk.clause_path_norm == ClauseReference.target_clause_path_norm,
                    target_chunk.is_parent.is_(False),
                ),
            )
            .where(
                ClauseReference.chunk_id.in_(chunk_ids),
                ClauseReference.ref_type == "R4",
                ClauseReference.resolution_status == "resolved",
                target_document.corpus_type == "P-EXT",
            )
            .order_by(ClauseReference.chunk_id, ClauseReference.ref_id)
        )
        source_laws: dict[str, list[dict]] = {}
        for (
            chunk_id,
            doc_no,
            version_title,
            document_title,
            clause_path,
            source_code,
        ) in session.execute(stmt):
            source_laws.setdefault(chunk_id, []).append(
                {
                    "doc_no": doc_no,
                    "doc_title": version_title or document_title,
                    "clause_path": clause_path,
                    "source_code": source_code,
                }
            )
    return {"existing": existing, "source_laws": source_laws}


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    chunk_ids, target = _validate(arguments)
    if not chunk_ids:
        return {"items": [], "rejected": [], "unresolved": [], "fallback": []}
    allowed = deps["registry"].allowed(auth.run_id)
    rejected = [chunk_id for chunk_id in chunk_ids if chunk_id not in allowed]
    permitted = [chunk_id for chunk_id in chunk_ids if chunk_id in allowed]
    if not permitted:
        return {"items": [], "rejected": rejected, "unresolved": [], "fallback": []}

    loader = deps.get("load_source_laws", _load_source_laws)
    loaded = loader(deps["pg"], permitted)
    existing = set(loaded.get("existing", set()))
    source_laws = loaded.get("source_laws", {})
    items: list[dict] = []
    unresolved: list[str] = []
    fallback: list[str] = []
    for chunk_id in permitted:
        if chunk_id not in existing:
            unresolved.append(chunk_id)
            continue
        laws = source_laws.get(chunk_id, [])
        if not laws and target is not None:
            laws = [
                {
                    "doc_no": target["doc_no"],
                    "doc_title": target["title"],
                    "clause_path": None,
                    "source_code": None,
                }
            ]
            fallback.append(chunk_id)
        if laws:
            items.append({"chunk_id": chunk_id, "source_laws": laws})
        else:
            unresolved.append(chunk_id)
    return {"items": items, "rejected": rejected, "unresolved": unresolved, "fallback": fallback}
