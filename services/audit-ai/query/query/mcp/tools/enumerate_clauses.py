"""T3 `enumerate_clauses` —— 条款树列举(高 k)。

包 `Retriever.retrieve_enumerate()`。

⚠ **本工具的安全约束是几个工具里最重的。** 底层收一个 `extra_expr` 原串,而它的字段白名单
`_ALLOWED_EXPR_FIELDS` **含 `perm_tag`**(`r4_listing.py:23`)—— 把原串放开给 agent 等于让它
改自己的权限。所以:

1. `extra_expr` **不出现在工具 schema 里**(agent 看不见);
2. 即便 `arguments` 里混进 `extra_expr`(模型猜到名字、或上游有 bug),**也绝不透传**;
3. C1 只接结构化维度参数,自己调 `array_any_expr()` 构造(白名单字段 + json 转义);
4. 授权层的 `perm_tag` 约束**不走这条路** —— 它由 `build_retrieval_scope` 单独构造,
   经 `scoped()` 与本表达式合取(`retrieve_enumerate` 内部的 `_and_expr`)。

枚举路只支持内/外规(`_corpora_for(scope, _PARTITIONS, _PARTITIONS)`),`qa`/`case` scope 下
为空是**刻意语义**,返回 `_scope_note` 显式说明,不静默空。
"""

from __future__ import annotations

import mcp.types as t

from query.listing.r4_listing import array_any_expr
from query.mcp.scope import AuthScope, ScopeError, build_retrieval_scope

_ENUMERABLE_CORPORA = ("internal", "external")
_SCOPE_NOTE = "本次授权不含内规/外规语料,枚举路无可检索分区。这不代表不存在相关条款。"

TOOL = t.Tool(
    name="enumerate_clauses",
    description=(
        "按业务维度列举条款(高召回,适合「罗列有哪些规定」类问题)。\n"
        "- biz_domains / entity_types:业务板块与主体类型,可多选;不确定就不要传\n"
        "- clause_only:只要条款级块(默认 true),关掉会混入整段原文块\n"
        "- ⚠ 本工具**不返回正文**,要看条款内容必须用 get_clause_detail\n"
        "- 只检索内规/外规;监管问答与案例不在枚举范围内"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "列举主题"},
            "biz_domains": {"type": "array", "items": {"type": "string"}},
            "entity_types": {"type": "array", "items": {"type": "string"}},
            "clause_only": {"type": "boolean", "default": True},
            "include_superseded": {"type": "boolean", "default": False},
        },
        "required": ["query"],
        "additionalProperties": False,
    },
)


def _string_list(arguments: dict, key: str) -> list[str]:
    raw = arguments.get(key)
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(v, str) and v for v in raw):
        raise ScopeError(-32602, f"invalid parameter: {key} must be an array of non-empty strings")
    return raw


def _build_expr(arguments: dict) -> str | None:
    """只用结构化参数构造,**绝不接受 `extra_expr` 原串**。

    每个子句都过 `array_any_expr`(assert 字段名 ∈ 白名单 + json 转义值)——
    Milvus expr 转义的唯一构造点,手拼字符串等于绕过注入防线。
    """
    clauses: list[str] = []
    if arguments.get("clause_only", True):
        clauses.append('chunk_type == "clause"')
    for key, field in (("biz_domains", "biz_domain"), ("entity_types", "entity_type")):
        values = _string_list(arguments, key)
        if values:
            clauses.append(array_any_expr(field, values))
    if not clauses:
        return None
    return " and ".join(clauses)


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ScopeError(-32602, "invalid parameter: query must be a non-empty string")
    include_superseded = arguments.get("include_superseded", False)
    if not isinstance(include_superseded, bool):
        raise ScopeError(-32602, "invalid parameter: include_superseded must be a boolean")

    if not any(c in _ENUMERABLE_CORPORA for c in auth.corpus_types):
        return {"items": [], "total": 0, "text_available": False, "_scope_note": _SCOPE_NOTE}

    # 先构造(会校验维度参数),再检索 —— 参数非法时不该已经发起了一次检索。
    extra_expr = _build_expr(arguments)

    retriever = deps["retriever"]
    scope = build_retrieval_scope(auth, {"includeSuperseded": include_superseded})
    with retriever.scoped(**scope):
        # 只传自己构造的 expr。arguments 里若混进 extra_expr,到这里已经被丢弃。
        candidates = retriever.retrieve_enumerate(
            query, extra_expr=extra_expr, include_superseded=include_superseded
        )

    items = [
        {
            "clause_id": c.chunk_id,
            "score": c.score,
            "source_code": c.source_code,
            "source_doc_id": c.source_doc_id,
            "clause_path": c.clause_path,
        }
        for c in candidates
        if not c.degraded
    ]
    deps["registry"].record(auth.run_id, [i["clause_id"] for i in items])

    # text 恒 null:该方法的 milvus.search() 未传 with_text(探针条 2)。
    return {"items": items, "total": len(items), "text_available": False}
