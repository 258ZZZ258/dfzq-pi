"""答复 TL;DR 综述富集(API 层,非路由/域):对**已装配答复**产 1-2 句摘要。

设计(SPEC-API `[query.enrich]`):summary 只概括**已装配、已引用锚定**的答复本身,不碰原始检索、
不重推事实。默认零 LLM(抽取式/模板兜底);仅 `summary_llm` 开 + gateway 时 LLM 提炼,护栏:不新增
制度名/文号/条款号/数字/结论,失败回落抽取(绝不阻断响应)。表格/卡片/数字型路由(R2/R3/R4/R6/
R7/R8)恒走确定性,不上 LLM——统计数字与逐字案例最怕 LLM 复述错/臆造。
"""

from __future__ import annotations

import json

from query.contract import BlockType, QueryResult, RouteType

# 仅散文生成型路由(R1 依据 / R5 判定)允许 LLM 概括;其余走确定性(首句/截断/计数)
_LLM_ROUTES = frozenset({RouteType.EVIDENCE, RouteType.JUDGMENTAL})

_SUMMARY_SYSTEM = (
    "你是审计制度答复的摘要器。任务:把【给定答复】压缩成 1-2 句 TL;DR。硬性规则:"
    "(1) 只概括给定答复本身,不得新增制度名称、发文字号、条款号、数字或结论,不得引入答复中"
    "没有的信息;(2) 不作答、不解释、不追加建议;(3) 无法概括时返回答复首句。只输出 JSON "
    '{"summary": "<1-2 句摘要>"},不输出 JSON 之外的任何文字。'
)

_SENT_END = "。！？!?"


def _readable(result: QueryResult) -> str:
    """可读文本 = TEXT 块拼接(表格 JSON / 案例卡不进摘要输入)。"""
    return "\n".join(
        b.content for b in result.answer_blocks
        if b.type is BlockType.TEXT and b.content and b.content.strip()
    ).strip()


def _truncate(text: str, maxn: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= maxn else text[: maxn - 1].rstrip() + "…"


def _first_sentence(text: str, maxn: int) -> str:
    for i, ch in enumerate(text):
        if ch in _SENT_END:
            return text[: i + 1] if i + 1 <= maxn else _truncate(text, maxn)
    return _truncate(text, maxn)


def _table_rows(result: QueryResult) -> int | None:
    for b in result.answer_blocks:
        if b.type is BlockType.TABLE:
            try:
                obj = json.loads(b.content)
            except (ValueError, TypeError):
                continue
            rows = obj.get("rows") if isinstance(obj, dict) else None
            if isinstance(rows, list):
                return len(rows)
    return None


def _deterministic(result: QueryResult, readable: str, maxn: int) -> str | None:
    if readable:
        return _first_sentence(readable, maxn)
    # 纯表格/卡片路由:计数句(确定性,数字取自结果结构,不经 LLM)
    n = _table_rows(result)
    if n is not None:
        return f"共 {n} 条结果(见表格)。"
    cards = sum(1 for b in result.answer_blocks if b.type is BlockType.CASE_CARD)
    if cards:
        return f"共 {cards} 个相关案例(见案例卡)。"
    return None


def summarize_answer(result: QueryResult, llm, cfg) -> str | None:
    """答复 TL;DR(None=无可摘要内容)。

    ``llm``:摘要 LLM 客户端(``summary_llm`` 关 / stub → None → 确定性兜底)。仅 R1/R5 且 llm 非空
    且有可读文本时走 LLM;LLM 抛/返空 → 回落确定性。
    """
    readable = _readable(result)
    maxn = max(20, cfg.summary_max_chars)
    if result.route_type in _LLM_ROUTES and llm is not None and readable:
        try:
            out = llm.chat_json(_SUMMARY_SYSTEM, f"答复:\n{readable}")
            s = (out or {}).get("summary")
            if isinstance(s, str) and s.strip():
                return _truncate(s, maxn)
        except Exception:  # noqa: BLE001 fail-safe:摘要失败不阻断响应,回落抽取(同富集纪律)
            pass
    return _deterministic(result, readable, maxn)
