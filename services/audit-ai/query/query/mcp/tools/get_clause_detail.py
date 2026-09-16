"""T4 `get_clause_detail` —— 按 id 取权威详情。**agent 取正文的唯一途径。**

三个 `retrieve*` 的 `text` 在当前配置下恒 null(`with_text = qcfg.rerank_backend != "none"`,
本机 `rerank_backend="none"`),所以下结论前必须过这个工具。

**这里也是 per-run 白名单的执行点。** T1/T2/T3 走的是带 scope 的检索路(前置过滤);
T4 是按 id 直取,绕过了 Milvus 过滤 —— 唯一的约束就是「id 必须来自本 run 的检索结果」。
白名单失效 = agent 可以按任意 id 从 PG 拉取条款正文,那是 widening(dfzq-pi 规格 §2.5 禁止)。

⚠ **正文用 `fetch_texts`,不是 `fetch_parent_text`。** dfzq-pi 主规格 §2.2 的 T4 写的是后者,
但实测全库 `chunks_with_parent = 0`,`fetch_parent_text` 对每一个真实命中都返回 None
(dfzq-pi 规格 §3.2.1)。`fetch_texts` 取块自身正文,与 `clause_id` 精确对应,粒度也更准。
"""

from __future__ import annotations

import mcp.types as t

from query.mcp.scope import AuthScope, ScopeError

TOOL = t.Tool(
    name="get_clause_detail",
    description=(
        "按 clause_id 取条款的权威详情与正文。**下结论前必须调用它** —— "
        "search_policy 返回的 text 可能为 null。\n"
        "- clause_ids 必须来自本次会话中 search_policy 的返回;臆造的 id 会进 rejected\n"
        "- rejected = 不在本次检索结果内(不是「不存在」,是「你没检索到过它」);"
        "not_found = 检索到过但库里查不到详情\n"
        "- version / page_start / page_end 常为 null,属正常,不要据此判断条款无效\n"
        "- status 是判断时效性的权威字段:effective / superseded / abolished"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "clause_ids": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "description": "来自 search_policy 返回的 clause_id",
            },
        },
        "required": ["clause_ids"],
        "additionalProperties": False,
    },
)

#: Citation 上要回给模型的字段。`text` 单独从 fetch_texts 取。
_CITATION_FIELDS = (
    "doc_title",
    "doc_no",
    "clause_path",
    "page_start",
    "page_end",
    "version",
    "status",
    "source_code",
    "source_doc_id",
)


def _validate(arguments: dict) -> list[str]:
    ids = arguments.get("clause_ids")
    if not isinstance(ids, list) or not ids:
        raise ScopeError(-32602, "invalid parameter: clause_ids must be a non-empty array")
    if not all(isinstance(i, str) and i for i in ids):
        raise ScopeError(-32602, "invalid parameter: clause_ids must contain non-empty strings")
    # 去重保序:重复 id 不该产生重复条目,也不该额外查一次 PG。
    return list(dict.fromkeys(ids))


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    """取详情。

    **「部分成功」以 `isError: false` 返回**(dfzq-pi 规格 §6-1):越权的进 `rejected`、
    查不到的进 `not_found`,已取到的照常返回。抛错会让模型连已经取到的那一半也看不见,
    而且带正文的错误响应会触发反幻觉误判。
    """
    requested = _validate(arguments)
    allowed = deps["registry"].allowed(auth.run_id)

    # 越权 id **根本不查 PG**,不是「查了但不返回」—— 后者会让一次慢查询的时序差
    # 变成探测 id 是否存在的侧信道。
    permitted = [i for i in requested if i in allowed]
    rejected = [i for i in requested if i not in allowed]

    pg = deps["pg"]
    fetch_anchors = deps["fetch_anchors"]
    fetch_texts = deps["fetch_texts"]

    anchors = fetch_anchors(pg, permitted) if permitted else {}
    found = [i for i in permitted if i in anchors]
    texts = fetch_texts(pg, found) if found else {}

    items = []
    for clause_id in found:
        citation = anchors[clause_id]
        item = {"clause_id": clause_id}
        for field in _CITATION_FIELDS:
            item[field] = getattr(citation, field, None)
        # 正文缺失是 null,不是错误(该块可能确实没有存正文)。
        item["text"] = texts.get(clause_id)
        items.append(item)

    # 取证记录(观测,非授权):T7 的取证完整性判定要知道哪些检索到的 id 真被取过正文。
    # 只标真正取到了详情的 —— not_found 的不算「取过」。
    deps["registry"].mark_fetched(auth.run_id, found)

    return {
        "items": items,
        "rejected": rejected,
        "not_found": [i for i in permitted if i not in anchors],
    }
