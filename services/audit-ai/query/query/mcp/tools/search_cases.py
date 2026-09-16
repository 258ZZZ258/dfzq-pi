"""T2 `search_cases` —— 案例检索。

包 `Retriever.retrieve_cases()`。**当前语料 `cases` 表 0 行**,业务正确性是已知缺口
(dfzq-pi 规格 §0.3);本模块保证的是结构正确性与 scope 语义。

两条与 T1 不同的语义:
1. **`text` 恒 null** —— 该方法的 `milvus.search()` 未传 `with_text`(探针条 2 实测)。
2. **上层必须按 `doc_version_id` 去重**(一案一卡)—— `retrieve_cases` 刻意不做,
   同一案例的多个 chunk 命中会让模型误以为有多个案例。
"""

from __future__ import annotations

import mcp.types as t

from query.mcp.scope import AuthScope, ScopeError, build_retrieval_scope

_SCOPE_NOTE = "case 语料不在本次授权范围内,未检索案例库。这不代表不存在相关案例。"

TOOL = t.Tool(
    name="search_cases",
    description=(
        "检索监管处罚案例。\n"
        "- 返回的是案例卡(一案一条),clause_id 可用于 get_clause_detail 取详情\n"
        "- ⚠ 本工具**不返回正文**,要看案例内容必须用 get_clause_detail\n"
        "- 若返回 _scope_note,说明案例库不在本次授权范围内 —— "
        "**那不等于「没有相关案例」**,不要据此下「无先例」的结论"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "案例检索词"},
            "include_superseded": {"type": "boolean", "default": False},
        },
        "required": ["query"],
        "additionalProperties": False,
    },
)


def _validate(arguments: dict) -> tuple[str, bool]:
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ScopeError(-32602, "invalid parameter: query must be a non-empty string")
    include_superseded = arguments.get("include_superseded", False)
    if not isinstance(include_superseded, bool):
        raise ScopeError(-32602, "invalid parameter: include_superseded must be a boolean")
    return query, include_superseded


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    query, include_superseded = _validate(arguments)

    # 授权里没有 case ⇒ **根本不发起检索**。只过滤结果是不够的:那仍是一次越权检索,
    # 即便结果被丢弃。返回显式说明而不是静默空数组(主规格 §2.2 T2:「不报错、不静默空」)。
    if "case" not in auth.corpus_types:
        return {"cases": [], "total": 0, "text_available": False, "_scope_note": _SCOPE_NOTE}

    retriever = deps["retriever"]
    scope = build_retrieval_scope(auth, {"includeSuperseded": include_superseded})
    with retriever.scoped(**scope):
        candidates = retriever.retrieve_cases(query, include_superseded=include_superseded)

    # 一案一卡:按 doc_version_id 去重,同一案例保最高分的那个 chunk。
    best: dict[str, object] = {}
    for cand in candidates:
        if cand.degraded:
            continue
        key = cand.doc_version_id or cand.chunk_id
        current = best.get(key)
        if current is None or cand.score > current.score:  # type: ignore[attr-defined]
            best[key] = cand

    cases = [
        {
            "clause_id": c.chunk_id,  # type: ignore[attr-defined]
            "doc_version_id": c.doc_version_id,  # type: ignore[attr-defined]
            "score": c.score,  # type: ignore[attr-defined]
            "source_code": c.source_code,  # type: ignore[attr-defined]
            "source_doc_id": c.source_doc_id,  # type: ignore[attr-defined]
        }
        for c in best.values()
    ]

    # 只登记真正返回给模型的 id —— 被去重掉的不进白名单。
    deps["registry"].record(auth.run_id, [c["clause_id"] for c in cases])

    return {"cases": cases, "total": len(cases), "text_available": False}
