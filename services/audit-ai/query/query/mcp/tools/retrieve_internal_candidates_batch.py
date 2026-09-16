"""批量检索内规候选，供外规→内规覆盖比对使用。

一批外规条款只做一次向量化，随后由 ``Retriever.retrieve_batch`` 在受权限约束的
``P-INT`` 分区并发检索。候选正文仍从 PG 权威源回查，避免把 Milvus 的截断文本交给
后续判定流程。
"""

from __future__ import annotations

from datetime import date

import mcp.types as t
from sqlalchemy import or_, select

from common.pg_models import Chunk, Document, DocVersion
from query.mcp.scope import AuthScope, ScopeError, build_retrieval_scope

TOOL = t.Tool(
    name="retrieve_internal_candidates_batch",
    description=(
        "对一批外规条款批量检索候选内规。服务端先批量嵌入，再以受限并发检索 P-INT，"
        "并返回已授权的内规权威正文。每个输入条款恰有一个同序 items 项；单条失败只在该项 error 标记。"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "clauses": {
                "type": "array",
                "minItems": 1,
                "maxItems": 800,
                "items": {
                    "type": "object",
                    "properties": {
                        "clause_path": {"type": ["string", "null"]},
                        "text": {"type": "string", "minLength": 1},
                    },
                    "required": ["text"],
                    "additionalProperties": False,
                },
            },
            "include_superseded": {"type": "boolean", "default": False},
            "effective_from": {"type": "string", "format": "date"},
            "effective_to": {"type": "string", "format": "date"},
        },
        "required": ["clauses"],
        "additionalProperties": False,
    },
)


def _optional_date(arguments: dict, key: str) -> str | None:
    value = arguments.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ScopeError(-32602, f"invalid parameter: {key} must be an ISO date")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ScopeError(-32602, f"invalid parameter: {key} must be an ISO date") from exc
    return value


def _validate(arguments: dict) -> tuple[list[dict], bool, str | None, str | None]:
    clauses = arguments.get("clauses")
    if not isinstance(clauses, list) or not clauses or len(clauses) > 800:
        raise ScopeError(-32602, "invalid parameter: clauses must contain 1 to 800 items")
    normalized = []
    for clause in clauses:
        if not isinstance(clause, dict):
            raise ScopeError(-32602, "invalid parameter: every clause must be an object")
        text = clause.get("text")
        path = clause.get("clause_path")
        if not isinstance(text, str) or not text.strip():
            raise ScopeError(-32602, "invalid parameter: every clause.text must be a non-empty string")
        if path is not None and not isinstance(path, str):
            raise ScopeError(-32602, "invalid parameter: clause_path must be a string or null")
        normalized.append({"text": text.strip(), "clause_path": path})
    include_superseded = arguments.get("include_superseded", False)
    if not isinstance(include_superseded, bool):
        raise ScopeError(-32602, "invalid parameter: include_superseded must be a boolean")
    effective_from = _optional_date(arguments, "effective_from")
    effective_to = _optional_date(arguments, "effective_to")
    if effective_from and effective_to and effective_from > effective_to:
        raise ScopeError(-32602, "invalid parameter: date range is reversed")
    return normalized, include_superseded, effective_from, effective_to


def _filter_target_chunks(pg, chunk_ids: list[str], effective_from: str | None, effective_to: str | None) -> set[str]:
    if not chunk_ids or (effective_from is None and effective_to is None):
        return set(chunk_ids)
    stmt = (
        select(Chunk.chunk_id)
        .join(DocVersion, DocVersion.doc_version_id == Chunk.doc_version_id)
        .join(Document, Document.logical_id == DocVersion.logical_id)
        .where(
            Chunk.chunk_id.in_(chunk_ids),
            Document.corpus_type == "P-INT",
            DocVersion.version_status == "effective",
        )
    )
    if effective_from:
        stmt = stmt.where(or_(DocVersion.invalid_date.is_(None), DocVersion.invalid_date >= date.fromisoformat(effective_from)))
    if effective_to:
        stmt = stmt.where(or_(DocVersion.effective_date.is_(None), DocVersion.effective_date <= date.fromisoformat(effective_to)))
    with pg.session() as session:
        return set(session.scalars(stmt))


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    clauses, include_superseded, effective_from, effective_to = _validate(arguments)
    # 没有内规授权时，不能向任何分区发检索；保持同序空项让调用方按外规条款生成缺失结果。
    if "internal" not in auth.corpus_types:
        return {
            "items": [{"query_index": i, "candidates": [], "error": None} for i in range(len(clauses))],
            "total": len(clauses),
        }

    retriever = deps["retriever"]
    scope = build_retrieval_scope(auth, {"includeSuperseded": include_superseded})
    if effective_to:
        target_expr = f"(effective_date == 0 or effective_date <= {effective_to.replace('-', '')})"
        scope["extra_expr"] = (
            f"({scope['extra_expr']}) and {target_expr}" if scope["extra_expr"] else target_expr
        )
    with retriever.scoped(**scope):
        batch = retriever.retrieve_batch([item["text"] for item in clauses], include_superseded=include_superseded)
    if len(batch) != len(clauses):
        raise RuntimeError(
            "batch retrieval returned an item count different from the input clause count"
        )
    # 单条失败可由调用方标记为该外规的待人工核查项；但整批都失败意味着嵌入/Milvus 等共同
    # 基础设施不可用。若继续返回一批空候选，覆盖比对会把技术故障误报为“全部缺失”。
    if batch and all(item.error is not None for item in batch):
        raise RuntimeError("all clause retrievals failed; refusing to report an infrastructure outage as coverage gaps")

    # 仅返回可供判定的非 degraded 候选，并批量取 PG 权威锚点和正文。
    ids = list(
        dict.fromkeys(
            candidate.chunk_id
            for item in batch
            for candidate in item.candidates
            if not candidate.degraded
        )
    )
    target_ids = deps.get("filter_target_chunks", _filter_target_chunks)(
        deps["pg"], ids, effective_from, effective_to
    )
    anchors = deps["fetch_anchors"](deps["pg"], list(target_ids)) if target_ids else {}
    texts = deps["fetch_texts"](deps["pg"], list(target_ids)) if target_ids else {}

    items = []
    returned_ids = []
    for index, item in enumerate(batch):
        candidates = []
        for candidate in item.candidates:
            if candidate.degraded:
                continue
            if candidate.chunk_id not in target_ids:
                continue
            anchor = anchors.get(candidate.chunk_id)
            text = texts.get(candidate.chunk_id)
            # 没有权威正文的候选不能进入模型判定，避免以截断向量库文本形成审计结论。
            if anchor is None or not isinstance(text, str) or not text:
                continue
            returned_ids.append(candidate.chunk_id)
            candidates.append(
                {
                    "chunk_id": candidate.chunk_id,
                    "clause_path": getattr(anchor, "clause_path", candidate.clause_path),
                    "doc_title": getattr(anchor, "doc_title", None),
                    "doc_no": getattr(anchor, "doc_no", None),
                    "text": text,
                    "source_code": getattr(anchor, "source_code", candidate.source_code),
                    "score": candidate.score,
                }
            )
        items.append({"query_index": index, "candidates": candidates, "error": item.error})

    deps["registry"].record(auth.run_id, returned_ids)
    return {"items": items, "total": len(items)}
