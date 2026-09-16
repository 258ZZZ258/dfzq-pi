"""T7 `assess_sufficiency` —— 证据充分性自查。

⚠ **本工具的语义与 dfzq-pi 主规格 §2.2 的声明不同,是刻意的**(规格 §3.2.0)。

主规格声明返回 `{sufficient, covered, missing, min_score_ok}`,但底层 `retrieve.sufficiency.assess`
的实现全文是:

    def assess(candidates, matters, *, min_hits=1) -> Sufficiency:
        return Sufficiency(sufficient=len(candidates) >= max(1, min_hits),
                           exhausted_scope=list(dict.fromkeys(matters)))

—— 它只是 **`len(candidates) >= min_hits` 的计数**;`matters` 原样去重回传、**不参与判定**;
`covered` / `missing` 底层不产出。包出一个假装做了语义分析的返回值,比不做更糟。

**所以本工具做两件如实的事**:

1. 转发 `assess()` 的计数结果,并**在字段名上写明它只是计数**;
2. 报**取证完整性** —— 本 run 检索到的 clause_id 里有多少真的取过正文。这是 C1 确实知道的
   (`RunRegistry` 有 T1/T2/T3 的登记与 T4 的取用记录),也是消费方 `sufficiency-gate` 插件的
   判定依据。

**如实登记局限**:第一次真 run 暴露的不收敛是「反复检索**并且**取正文却不给结论」,
取证完整性判定未必能治它 —— 真正强制收敛的是输出契约。本工具防的是
「检索了却不取正文就下结论」,不是「查太多」。
"""

from __future__ import annotations

import mcp.types as t

from query.mcp.scope import AuthScope, ScopeError
from query.retrieve.sufficiency import assess

TOOL = t.Tool(
    name="assess_sufficiency",
    description=(
        "自查取证是否完整:报告本次会话检索到了多少条款、其中多少已取过正文。\n"
        "- matters:你打算回答的要点列表(用于回显,便于你自己核对是否都查过)\n"
        "- unfetched 非空 = 你检索到了这些条款但还没取正文,"
        "**下结论前应该先用 get_clause_detail 取它们**\n"
        "- ⚠ hit_count_sufficient 只是「检索命中数是否达标」的计数,"
        "**不代表证据在语义上覆盖了你的问题** —— 那要你自己判断"
    ),
    input_schema={
        "type": "object",
        "properties": {
            "matters": {
                "type": "array",
                "items": {"type": "string"},
                "description": "待回答的要点",
            },
        },
        "required": ["matters"],
        "additionalProperties": False,
    },
)

#: 与 audit-ai 既有默认一致;真正的阈值由 qcfg.sufficiency_min_hits 决定,这里只是兜底。
_DEFAULT_MIN_HITS = 1


def call(auth: AuthScope, arguments: dict, deps: dict) -> dict:
    matters = arguments.get("matters")
    if not isinstance(matters, list) or not all(isinstance(m, str) and m for m in matters):
        raise ScopeError(-32602, "invalid parameter: matters must be an array of non-empty strings")

    registry = deps["registry"]
    stats = registry.stats(auth.run_id)
    unfetched = registry.unfetched(auth.run_id)

    qcfg = deps.get("qcfg")
    min_hits = getattr(qcfg, "sufficiency_min_hits", _DEFAULT_MIN_HITS) or _DEFAULT_MIN_HITS

    # 转发底层 assess():它只看候选数。这里用「检索到的 id 数」当候选数 —— 语义等价,
    # 因为登记的正是每次检索真正返回给模型的条目。
    verdict = assess(range(stats["retrieved_count"]), matters, min_hits=min_hits)

    return {
        # 字段名刻意写成 hit_count_sufficient 而不是 sufficient:它**只是计数达标**,
        # 叫 sufficient 会让模型(和读代码的人)以为做过语义判定。
        "hit_count_sufficient": verdict.sufficient,
        "exhausted_scope": verdict.exhausted_scope,
        "retrieved_count": stats["retrieved_count"],
        "fetched_count": stats["fetched_count"],
        "unfetched": unfetched,
    }
