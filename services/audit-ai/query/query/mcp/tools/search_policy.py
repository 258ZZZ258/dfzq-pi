"""T1 `search_policy` —— 制度检索。

包 `Retriever.retrieve()`(内部已含子查询分解 fan-out + 重排)。零内核改动。

**红线**:检索必须包在 `retriever.scoped(**scope)` 内 —— 前置过滤,不是检索后过滤。
"""

from __future__ import annotations

import mcp.types as t

from query.mcp.scope import AuthScope, ScopeError, build_retrieval_scope

#: 实测:当前环境 rerank_backend="none" ⇒ `with_text=False` ⇒ text 恒 null。
#: 即便开了重排,Milvus 返回的也只是截断 text。所以取正文的唯一途径是 T4。
_TEXT_HINT = "检索结果的 text 可能为 null;下结论前必须用 get_clause_detail 取权威正文。"

# ⚠ **没有 mode 参数,这是刻意的。**
#
# dfzq-pi 主规格 §2.2 的 T1 声明了 `mode: "hybrid" | "hyde"`,但底层实现不了:
# `Retriever.retrieve()` 的签名是 `(query, *, include_superseded=False)`,HyDE 由构造期
# 注入的 `_hyde_llm` 控制(`hybrid.py:97-99,168,208` —— 开关是 `qcfg.hyde`),**不是
# per-call 参数**。声明一个不起作用的参数比不声明更糟:模型会以为自己切换了检索策略。
#
# 情景描述型问题的处置改为写进 description,让模型自己把口语改写成监管表述再检索 ——
# 这与 HyDE 的意图一致,只是把改写这一步从服务端挪到了模型侧。
TOOL = t.Tool(
    name="search_policy",
    description=(
        "检索制度条款(内规/外规/监管问答/案例,范围由本次授权决定)。\n"
        "- include_superseded: 默认 false,只检现行有效;要看历史版本才置 true\n"
        "- 口语化的情景描述(如「见底了到顶了算不算荐股」)直接检索命中率低,"
        "**先把它改写成监管表述再传入**(如「证券投资顾问 提供买卖建议 具体股票」)\n"
        f"- ⚠ {_TEXT_HINT} 返回的 text_available 标志说明本次是否带回了正文。\n"
        "- 返回的 clause_id 是后续 get_clause_detail 的唯一合法输入;不要臆造 id。\n"
        "- 条数由服务端授权范围决定,本工具不接受条数参数。"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "检索词或问题(情景描述请先改写成监管表述)"},
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


def _to_hit(cand) -> dict:
    """`Candidate` → T1 的返回形状。字段全部来自候选本身,**不新增 PG 回查**。"""
    return {
        "clause_id": cand.chunk_id,
        "text": cand.text,
        "score": cand.score,
        "source_code": cand.source_code,
        "source_doc_id": cand.source_doc_id,
        "corpus_type": cand.corpus_type,
        "clause_path": cand.clause_path,
    }


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    """检索并登记 clause_id。

    命中 0 条**不是错误**(规格 §2.4):返回空数组,让模型自己决定换词还是拒答。
    """
    query, include_superseded = _validate(arguments)

    retriever = deps["retriever"]
    scope = build_retrieval_scope(auth, {"includeSuperseded": include_superseded})
    # 红线:前置过滤。retrieve() 必须在 scoped() 内 —— 挪到外面返回值看起来完全正常,
    # 但那是一次无过滤检索。test_retrieval_runs_inside_scoped 守这一条。
    with retriever.scoped(**scope):
        candidates = retriever.retrieve(query, include_superseded=include_superseded)

    # degraded 块仅全文检索、不参与条款级引用(audit-ai 契约)。
    kept = [c for c in candidates if not c.degraded]
    hits = [_to_hit(c) for c in kept]

    # 只登记**真正返回给模型的** id。丢弃的 degraded 若也进白名单,模型猜一个 id 就能取详情。
    deps["registry"].record(auth.run_id, [h["clause_id"] for h in hits])

    return {
        "hits": hits,
        "total": len(hits),
        "text_available": any(h["text"] for h in hits),
        "_hint": _TEXT_HINT,
    }
