"""T2 search_cases 的判别性测试。

⚠ 当前语料 `cases` 表 0 行、`retrieve_cases` 实测三个查询词全部零命中。
所以这里验的是**结构正确性与 scope 语义**,业务正确性是已知缺口(规格 §0.3)。
"""

import contextlib

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import search_cases


class FakeCandidate:
    def __init__(self, chunk_id, doc_version_id="dv-1", degraded=False, score=0.5):
        self.chunk_id = chunk_id
        self.score = score
        self.corpus_type = "case"
        self.doc_version_id = doc_version_id
        self.clause_path = None
        self.page_start = None
        self.degraded = degraded
        self.retrieval_mode = "hybrid"
        self.text = None
        self.rerank_score = None
        self.source_code = "SRC-1"
        self.source_doc_id = "DOC-1"


class FakeRetriever:
    def __init__(self, hits):
        self.hits = hits
        self.scoped_with = None
        self.retrieved_inside_scope = None
        self._in_scope = False

    @contextlib.contextmanager
    def scoped(self, **kwargs):
        self.scoped_with = kwargs
        self._in_scope = True
        try:
            yield
        finally:
            self._in_scope = False

    def retrieve_cases(self, query, *, include_superseded=False):
        self.retrieved_inside_scope = self._in_scope
        return self.hits


def _deps(retriever, registry=None):
    return {"retriever": retriever, "registry": registry or RunRegistry()}


CASE_AUTH = AuthScope(["P1"], ["case", "external"], "r-1")


def test_returns_cases_with_recall_keys():
    r = FakeRetriever([FakeCandidate("c1")])
    out = search_cases.call(CASE_AUTH, {"query": "投顾代客理财"}, _deps(r))
    assert out["total"] == 1
    assert out["cases"][0]["clause_id"] == "c1"
    assert out["cases"][0]["doc_version_id"] == "dv-1"


def test_retrieval_runs_inside_scoped():
    r = FakeRetriever([FakeCandidate("c1")])
    search_cases.call(CASE_AUTH, {"query": "x"}, _deps(r))
    assert r.retrieved_inside_scope is True


def test_scope_without_case_returns_empty_with_a_note_not_an_error():
    # 主规格 §2.2 T2:corpus_types 不含 case 时「不报错、不静默空」——
    # 必须显式说明是授权范围问题,否则模型会以为「没有相关案例」而据此下结论。
    r = FakeRetriever([FakeCandidate("c1")])
    auth = AuthScope(["P1"], ["external"], "r-1")
    out = search_cases.call(auth, {"query": "x"}, _deps(r))
    assert out["cases"] == []
    assert out["total"] == 0
    assert out["_scope_note"]
    assert "case" in out["_scope_note"] or "案例" in out["_scope_note"]


def test_scope_without_case_does_not_even_retrieve():
    # 不只是过滤结果:根本不该发起检索。发了就是一次越权检索,即便结果被丢弃。
    r = FakeRetriever([FakeCandidate("c1")])
    auth = AuthScope(["P1"], ["external"], "r-1")
    search_cases.call(auth, {"query": "x"}, _deps(r))
    assert r.retrieved_inside_scope is None


def test_text_available_is_always_false():
    # retrieve_cases 的 milvus.search() 未传 with_text ⇒ text 恒 null(探针条 2)。
    # 声明成 True 会让模型以为拿到了正文。
    r = FakeRetriever([FakeCandidate("c1")])
    out = search_cases.call(CASE_AUTH, {"query": "x"}, _deps(r))
    assert out["text_available"] is False


def test_dedupes_by_doc_version_keeping_highest_score():
    # 一案一卡(主规格 §2.2 T2:该方法刻意不做去重,上层必须做)。
    # 同一案例的多个 chunk 命中会让模型误以为有多个案例。
    r = FakeRetriever([
        FakeCandidate("c1", doc_version_id="dv-1", score=0.3),
        FakeCandidate("c2", doc_version_id="dv-1", score=0.9),
        FakeCandidate("c3", doc_version_id="dv-2", score=0.5),
    ])
    out = search_cases.call(CASE_AUTH, {"query": "x"}, _deps(r))
    assert out["total"] == 2
    ids = [c["clause_id"] for c in out["cases"]]
    assert "c2" in ids and "c1" not in ids  # 同 dv 保高分
    assert "c3" in ids


def test_degraded_candidates_are_dropped():
    r = FakeRetriever(
        [FakeCandidate("c1"), FakeCandidate("c2", doc_version_id="dv-2", degraded=True)]
    )
    out = search_cases.call(CASE_AUTH, {"query": "x"}, _deps(r))
    assert [c["clause_id"] for c in out["cases"]] == ["c1"]


def test_records_clause_ids_into_the_run_allowlist():
    reg = RunRegistry()
    r = FakeRetriever([FakeCandidate("c1")])
    search_cases.call(CASE_AUTH, {"query": "x"}, _deps(r, reg))
    assert reg.allowed("r-1") == {"c1"}


def test_deduped_away_ids_are_not_recorded():
    # 没返回给模型的 id 不该进白名单。
    reg = RunRegistry()
    r = FakeRetriever([
        FakeCandidate("c1", doc_version_id="dv-1", score=0.3),
        FakeCandidate("c2", doc_version_id="dv-1", score=0.9),
    ])
    search_cases.call(CASE_AUTH, {"query": "x"}, _deps(r, reg))
    assert reg.allowed("r-1") == {"c2"}


def test_missing_query_is_a_param_error():
    with pytest.raises(ScopeError) as e:
        search_cases.call(CASE_AUTH, {}, _deps(FakeRetriever([])))
    assert e.value.code == -32602


def test_tool_schema_hides_the_authorization_layer():
    props = search_cases.TOOL.input_schema["properties"]
    for forbidden in ("perm_tags", "corpus_types", "run_id"):
        assert forbidden not in props
