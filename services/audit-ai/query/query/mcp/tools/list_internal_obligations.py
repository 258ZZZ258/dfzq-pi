"""制度比对 M1:按授权范围列出库内义务条款。"""

from __future__ import annotations

from datetime import date
from typing import Any

import mcp.types as t
from sqlalchemy import or_, select

from common.pg_models import Chunk, ClauseTag, Document, DocVersion
from query.mcp.scope import AuthScope, ScopeError

TOOL = t.Tool(
    name="list_internal_obligations",
    description=(
        "按本次授权和核查范围列出库内现行有效的内规义务条款。"
        "返回权威正文和条款标识，供制度覆盖度工作流使用；最多 500 条。"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "organizations": {"type": "array", "items": {"type": "string"}},
            "biz_domains": {"type": "array", "items": {"type": "string"}},
            "chapters": {"type": "array", "items": {"type": "string"}},
            "effective_from": {"type": "string", "format": "date"},
            "effective_to": {"type": "string", "format": "date"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 500},
        },
        "additionalProperties": False,
    },
)


def _string_list(arguments: dict, key: str) -> list[str]:
    raw = arguments.get(key, [])
    if not isinstance(raw, list) or not all(isinstance(v, str) and v.strip() for v in raw):
        raise ScopeError(-32602, f"invalid parameter: {key} must be an array of non-empty strings")
    return [v.strip() for v in raw]


def _optional_date(arguments: dict, key: str) -> date | None:
    raw = arguments.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ScopeError(-32602, f"invalid parameter: {key} must be an ISO date")
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ScopeError(-32602, f"invalid parameter: {key} must be an ISO date") from exc


def _validate(arguments: dict) -> dict[str, Any]:
    organizations = _string_list(arguments, "organizations")
    # 当前权威库没有组织字段。静默忽略会把查询范围扩大，必须 fail-closed。
    if organizations:
        raise ScopeError(-32602, "invalid parameter: organizations is not supported by audit-ai")
    biz_domains = _string_list(arguments, "biz_domains")
    chapters = _string_list(arguments, "chapters")
    effective_from = _optional_date(arguments, "effective_from")
    effective_to = _optional_date(arguments, "effective_to")
    if effective_from and effective_to and effective_from > effective_to:
        raise ScopeError(-32602, "invalid parameter: date range is reversed")
    limit = arguments.get("limit", 500)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ScopeError(-32602, "invalid parameter: limit must be an integer from 1 to 500")
    return {
        "organizations": organizations,
        "biz_domains": biz_domains,
        "chapters": chapters,
        "effective_from": effective_from,
        "effective_to": effective_to,
        "limit": limit,
    }


def _normalize_deontic(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    if value in {"prohibition", "不得", "禁止", "严禁"}:
        return "prohibition"
    if value in {"command", "命令"}:
        return "command"
    return "obligation"


def _load_internal_obligations(pg, auth: AuthScope, params: dict[str, Any]) -> list[dict]:
    stmt = (
        select(Chunk, ClauseTag, DocVersion, Document)
        .join(ClauseTag, ClauseTag.chunk_id == Chunk.chunk_id)
        .join(DocVersion, DocVersion.doc_version_id == Chunk.doc_version_id)
        .join(Document, Document.logical_id == DocVersion.logical_id)
        .where(
            ClauseTag.tag_type == "is_obligation",
            Document.corpus_type == "P-INT",
            DocVersion.version_status == "effective",
            Chunk.is_parent.is_(False),
            Chunk.degraded.is_(False),
            Chunk.chunk_type == "clause",
        )
        .order_by(DocVersion.doc_version_id, Chunk.seq, ClauseTag.id)
    )
    if auth.perm_tags:
        stmt = stmt.where(DocVersion.perm_tag.in_(auth.perm_tags))
    if params["effective_from"]:
        stmt = stmt.where(
            or_(
                DocVersion.invalid_date.is_(None),
                DocVersion.invalid_date >= params["effective_from"],
            )
        )
    if params["effective_to"]:
        stmt = stmt.where(
            or_(
                DocVersion.effective_date.is_(None),
                DocVersion.effective_date <= params["effective_to"],
            )
        )
    if params["biz_domains"]:
        domain_clauses = [DocVersion.biz_domains.contains([v]) for v in params["biz_domains"]]
        domain_clauses.extend(DocVersion.biz_domain == v for v in params["biz_domains"])
        stmt = stmt.where(or_(*domain_clauses))
    if params["chapters"]:
        stmt = stmt.where(or_(*(Chunk.clause_path.contains(v) for v in params["chapters"])))

    rows: list[dict] = []
    with pg.session() as session:
        for chunk, tag, version, document in session.execute(stmt):
            rows.append(
                {
                    "chunk_id": chunk.chunk_id,
                    "clause_path": chunk.clause_path,
                    "doc_title": version.title or document.title,
                    "doc_no": version.doc_number or version.file_no,
                    "deontic_type": tag.deontic_type,
                    "evidence": tag.evidence,
                    "text": chunk.text,
                    "source_code": chunk.source_code,
                }
            )
    return rows


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    params = _validate(arguments)
    if "internal" not in auth.corpus_types:
        return {"items": [], "total": 0, "truncated": False}

    loader = deps.get("load_internal_obligations", _load_internal_obligations)
    raw_rows = loader(deps["pg"], auth, params)
    unique: list[dict] = []
    seen: set[str] = set()
    for raw in raw_rows:
        chunk_id = raw.get("chunk_id")
        if not isinstance(chunk_id, str) or not chunk_id or chunk_id in seen:
            continue
        seen.add(chunk_id)
        unique.append(
            {
                "chunk_id": chunk_id,
                "clause_path": raw.get("clause_path"),
                "doc_title": raw.get("doc_title"),
                "doc_no": raw.get("doc_no"),
                "deontic_type": _normalize_deontic(raw.get("deontic_type")),
                "evidence": raw.get("evidence"),
                "text": str(raw.get("text") or ""),
                "source_code": raw.get("source_code"),
            }
        )

    items = unique[: params["limit"]]
    deps["registry"].record(auth.run_id, [row["chunk_id"] for row in items])
    return {"items": items, "total": len(unique), "truncated": len(unique) > len(items)}
