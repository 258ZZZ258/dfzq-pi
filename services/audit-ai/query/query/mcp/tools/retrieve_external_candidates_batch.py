"""批量检索外规候选，供内规→外规覆盖比对使用。"""

from __future__ import annotations

import mcp.types as t

from query.mcp.scope import AuthScope, build_retrieval_scope
from query.mcp.tools.retrieve_internal_candidates_batch import _validate

TOOL = t.Tool(
    name="retrieve_external_candidates_batch",
    description=(
        "对一批内规义务条款批量检索候选外规。服务端先批量嵌入，再以受限并发检索 P-EXT，"
        "并返回已授权的外规权威正文。每个输入条款恰有一个同序 items 项；单条失败只在该项 error 标记。"
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
        },
        "required": ["clauses"],
        "additionalProperties": False,
    },
)


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    clauses, include_superseded, _effective_from, _effective_to = _validate(arguments)
    # 缺少外规授权时不发检索，保持输入同序空项，调用方不会把权限不足误报为基础设施故障。
    if "external" not in auth.corpus_types:
        return {
            "items": [{"query_index": i, "candidates": [], "error": None} for i in range(len(clauses))],
            "total": len(clauses),
        }

    retriever = deps["retriever"]
    scope = build_retrieval_scope(auth, {"includeSuperseded": include_superseded})
    with retriever.scoped(**scope):
        batch = retriever.retrieve_batch(
            [item["text"] for item in clauses],
            include_superseded=include_superseded,
            corpora=("P-EXT",),
        )
    if len(batch) != len(clauses):
        raise RuntimeError("batch retrieval returned an item count different from the input clause count")
    if batch and all(item.error is not None for item in batch):
        raise RuntimeError("all clause retrievals failed; refusing to report an infrastructure outage as coverage gaps")

    ids = list(dict.fromkeys(
        candidate.chunk_id for item in batch for candidate in item.candidates if not candidate.degraded
    ))
    anchors = deps["fetch_anchors"](deps["pg"], ids) if ids else {}
    texts = deps["fetch_texts"](deps["pg"], ids) if ids else {}
    items = []
    returned_ids = []
    for index, item in enumerate(batch):
        candidates = []
        for candidate in item.candidates:
            if candidate.degraded:
                continue
            anchor = anchors.get(candidate.chunk_id)
            text = texts.get(candidate.chunk_id)
            if anchor is None or not isinstance(text, str) or not text:
                continue
            returned_ids.append(candidate.chunk_id)
            candidates.append({
                "chunk_id": candidate.chunk_id,
                "clause_path": getattr(anchor, "clause_path", candidate.clause_path),
                "doc_title": getattr(anchor, "doc_title", None),
                "doc_no": getattr(anchor, "doc_no", None),
                "text": text,
                "source_code": getattr(anchor, "source_code", candidate.source_code),
                "score": candidate.score,
            })
        items.append({"query_index": index, "candidates": candidates, "error": item.error})

    deps["registry"].record(auth.run_id, returned_ids)
    return {"items": items, "total": len(items)}
