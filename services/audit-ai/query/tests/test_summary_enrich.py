"""答复 TL;DR 综述富集(enrich.summary)单元:零网络。

覆盖:散文路由(R1/R5)LLM 概括 + 抽取兜底 + fail-safe;表格/卡片/统计路由(R2/R3/R4/R6)确定性
计数/首句、**绝不调 LLM**;QueryResult.summary 默认 None → to_dict 省略(byte 等价)。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from query.contract import AnswerBlock, BlockType, QueryResult, RouteType
from query.enrich import summarize_answer

_CFG = SimpleNamespace(summary_max_chars=120)


def _result(route, blocks):
    return QueryResult(route_type=route, answer_blocks=blocks)


class _SpyLLM:
    """调 chat_json 即抛 → 用于断言"不该调 LLM 的路由"确实没调。"""

    def chat_json(self, system, user):
        raise AssertionError("LLM 不应被调用")


class _FakeLLM:
    def __init__(self, payload):
        self._payload = payload
        self.calls = 0

    def chat_json(self, system, user):
        self.calls += 1
        return self._payload


def test_evidence_extractive_when_no_llm():
    # R1 无 llm(summary_llm 关)→ 抽取式首句
    r = _result(RouteType.EVIDENCE, [
        AnswerBlock(BlockType.TEXT, "客户适当性管理要求经营机构进行风险测评。此外还需留痕。"),
    ])
    out = summarize_answer(r, None, _CFG)
    assert out == "客户适当性管理要求经营机构进行风险测评。"  # 取首句


def test_evidence_llm_summarizes():
    # R1 + gateway 摘要 llm → 用 LLM 输出(截断封顶)
    r = _result(RouteType.EVIDENCE, [AnswerBlock(BlockType.TEXT, "很长的依据答复……")])
    llm = _FakeLLM({"summary": "适当性管理需风险测评并留痕。"})
    out = summarize_answer(r, llm, _CFG)
    assert out == "适当性管理需风险测评并留痕。" and llm.calls == 1


def test_evidence_llm_failsafe_falls_back():
    # LLM 抛 → 回落抽取,不阻断
    class _Boom:
        def chat_json(self, s, u):
            raise RuntimeError("gateway 超时")

    r = _result(RouteType.EVIDENCE, [AnswerBlock(BlockType.TEXT, "依据答复首句。后续细节。")])
    out = summarize_answer(r, _Boom(), _CFG)
    assert out == "依据答复首句。"


def test_evidence_llm_empty_falls_back():
    # LLM 返空/非串 → 回落抽取
    r = _result(RouteType.EVIDENCE, [AnswerBlock(BlockType.TEXT, "首句在此。补充说明。")])
    out = summarize_answer(r, _FakeLLM({"summary": ""}), _CFG)
    assert out == "首句在此。"


def test_stats_route_template_never_calls_llm():
    # R6 统计:纯 TABLE → 计数句;即便传 llm 也**不得调**(数字不过 LLM)
    table = json.dumps({"columns": ["a"], "rows": [[1], [2], [3]]}, ensure_ascii=False)
    r = _result(RouteType.STATISTICAL, [AnswerBlock(BlockType.TABLE, table, stream=False)])
    out = summarize_answer(r, _SpyLLM(), _CFG)  # SpyLLM.chat_json 抛 → 若被调则测试失败
    assert out == "共 3 条结果(见表格)。"


def test_enumerate_route_template():
    table = json.dumps({"columns": ["制度"], "rows": [["A"], ["B"]]}, ensure_ascii=False)
    r = _result(RouteType.ENUMERATE, [AnswerBlock(BlockType.TABLE, table, stream=False)])
    assert summarize_answer(r, _SpyLLM(), _CFG) == "共 2 条结果(见表格)。"


def test_change_route_uses_leading_text_not_llm():
    # R2 变更:有首个 TEXT(版本行)→ 用它,不调 LLM
    r = _result(RouteType.CHANGE, [
        AnswerBlock(BlockType.TEXT, "「X 制度」现行版较前版有 2 处条款变更。"),
        AnswerBlock(BlockType.TABLE, json.dumps({"rows": [[1], [2]]}), stream=False),
    ])
    assert summarize_answer(r, _SpyLLM(), _CFG) == "「X 制度」现行版较前版有 2 处条款变更。"


def test_case_route_card_count_not_llm():
    # R3 案例:CASE_CARD 卡片 → 计数句(守零臆造,不调 LLM)
    r = _result(RouteType.CASE, [
        AnswerBlock(BlockType.CASE_CARD, "{}"), AnswerBlock(BlockType.CASE_CARD, "{}"),
    ])
    assert summarize_answer(r, _SpyLLM(), _CFG) == "共 2 个相关案例(见案例卡)。"


def test_empty_answer_returns_none():
    assert summarize_answer(_result(RouteType.REFUSE, []), None, _CFG) is None


def test_truncation_caps_length():
    long = "甲" * 300
    r = _result(RouteType.EVIDENCE, [AnswerBlock(BlockType.TEXT, long)])
    out = summarize_answer(r, None, SimpleNamespace(summary_max_chars=50))
    assert out is not None and len(out) <= 50


def test_to_dict_omits_summary_when_none():
    # 域/CLI 默认 summary=None → to_dict 无 "summary" 键(与既有契约 byte 等价)
    d = _result(RouteType.EVIDENCE, [AnswerBlock(BlockType.TEXT, "x")]).to_dict()
    assert "summary" not in d


def test_to_dict_includes_summary_when_set():
    r = _result(RouteType.EVIDENCE, [AnswerBlock(BlockType.TEXT, "x")])
    r.summary = "一句摘要。"
    assert r.to_dict()["summary"] == "一句摘要。"
