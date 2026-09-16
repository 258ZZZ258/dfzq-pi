"""T7 assess_sufficiency 的判别性测试。

本工具的语义与主规格声明不同(规格 §3.2.0):底层 assess() 只是计数,
所以这里验的是「如实转发计数」+「取证完整性真实反映 RunRegistry」。
"""

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import assess_sufficiency

AUTH = AuthScope(["P1"], ["external"], "r-1")


def _deps(registry):
    return {"registry": registry, "qcfg": None}


def test_reports_fetch_gap():
    reg = RunRegistry()
    reg.record("r-1", ["a", "b", "c"])
    reg.mark_fetched("r-1", ["a"])
    out = assess_sufficiency.call(AUTH, {"matters": ["要点1"]}, _deps(reg))
    assert out["retrieved_count"] == 3
    assert out["fetched_count"] == 1
    assert out["unfetched"] == ["b", "c"]


def test_no_gap_when_everything_is_fetched():
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    reg.mark_fetched("r-1", ["a"])
    out = assess_sufficiency.call(AUTH, {"matters": ["x"]}, _deps(reg))
    assert out["unfetched"] == []


def test_field_is_named_hit_count_sufficient_not_sufficient():
    # 命名是这个工具最重要的设计:底层只做计数,叫 sufficient 会让模型以为做过语义判定。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    out = assess_sufficiency.call(AUTH, {"matters": ["x"]}, _deps(reg))
    assert "hit_count_sufficient" in out
    assert "sufficient" not in out


def test_zero_hits_is_not_sufficient():
    out = assess_sufficiency.call(AUTH, {"matters": ["x"]}, _deps(RunRegistry()))
    assert out["hit_count_sufficient"] is False
    assert out["retrieved_count"] == 0


def test_matters_are_echoed_as_exhausted_scope():
    # 底层 assess() 就是这么干的(原样去重回传)。如实转发,不假装它参与了判定。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    out = assess_sufficiency.call(AUTH, {"matters": ["要点1", "要点2", "要点1"]}, _deps(reg))
    assert out["exhausted_scope"] == ["要点1", "要点2"]


def test_is_per_run():
    reg = RunRegistry()
    reg.record("r-1", ["a", "b"])
    reg.record("r-2", ["c"])
    out = assess_sufficiency.call(AUTH, {"matters": ["x"]}, _deps(reg))
    assert out["retrieved_count"] == 2


def test_missing_matters_is_a_param_error():
    with pytest.raises(ScopeError) as e:
        assess_sufficiency.call(AUTH, {}, _deps(RunRegistry()))
    assert e.value.code == -32602


def test_description_warns_that_it_is_only_a_count():
    # 描述必须说清局限,否则模型会拿 hit_count_sufficient 当「证据够了」。
    assert "不代表" in assess_sufficiency.TOOL.description


def test_tool_schema_hides_the_authorization_layer():
    props = assess_sufficiency.TOOL.input_schema["properties"]
    for forbidden in ("perm_tags", "corpus_types", "run_id"):
        assert forbidden not in props


def test_schema_has_no_clause_ids():
    # 主规格 T7 声明了 clause_ids 入参,但白名单本来就在服务端 ——
    # 让 agent 传一份等于给它一个可以说谎的地方。
    assert "clause_ids" not in assess_sufficiency.TOOL.input_schema["properties"]
