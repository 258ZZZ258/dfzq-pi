"""T1 search_policy 的判别性测试。用假 Retriever,不连真栈(真栈验证在 Task 8)。"""

import contextlib

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import search_policy


class FakeCandidate:
    def __init__(self, chunk_id, corpus_type="external", text=None, degraded=False):
        self.chunk_id = chunk_id
        self.score = 0.5
        self.corpus_type = corpus_type
        self.doc_version_id = "dv-1"
        self.clause_path = "第一条"
        self.page_start = None
        self.degraded = degraded
        self.retrieval_mode = "hybrid"
        self.text = text
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

    def retrieve(self, query, *, include_superseded=False):
        # 记录「检索发生时是否在 scope 内」—— 红线是前置过滤,不是事后过滤。
        self.retrieved_inside_scope = self._in_scope
        return self.hits


def _deps(retriever, registry=None):
    return {"retriever": retriever, "registry": registry or RunRegistry()}


AUTH = AuthScope(["P1"], ["external"], "r-1")


def test_returns_hits_with_recall_keys():
    r = FakeRetriever([FakeCandidate("c1")])
    out = search_policy.call(AUTH, {"query": "合规检查"}, _deps(r))
    assert out["total"] == 1
    hit = out["hits"][0]
    assert hit["clause_id"] == "c1"
    # A2 的回查键:Java 按这两个回查达梦四级引用
    assert hit["source_code"] == "SRC-1"
    assert hit["source_doc_id"] == "DOC-1"
    # A4 的判据字段
    assert hit["corpus_type"] == "external"


def test_retrieval_runs_inside_scoped():
    # 红线:前置过滤必须在检索**前**生效。没进 scoped() 就等于无过滤检索,
    # 而返回值看起来完全正常 —— 这正是 mock 验不出、只有这条断言能拦的越权。
    r = FakeRetriever([FakeCandidate("c1")])
    search_policy.call(AUTH, {"query": "x"}, _deps(r))
    assert r.retrieved_inside_scope is True
    assert set(r.scoped_with["corpora"]) == {"P-EXT"}


def test_scope_carries_perm_tags_into_the_expr():
    r = FakeRetriever([])
    search_policy.call(AUTH, {"query": "x"}, _deps(r))
    assert "perm_tag" in (r.scoped_with["extra_expr"] or "")


def test_text_available_is_false_when_all_text_is_null():
    # 当前环境 rerank_backend="none" ⇒ text 恒 null,agent 必须走 T4(规格 §0.3)
    r = FakeRetriever([FakeCandidate("c1", text=None)])
    out = search_policy.call(AUTH, {"query": "x"}, _deps(r))
    assert out["text_available"] is False
    assert "_hint" in out
    assert "get_clause_detail" in out["_hint"]


def test_text_available_is_true_when_text_is_present():
    r = FakeRetriever([FakeCandidate("c1", text="第十六条 ……")])
    out = search_policy.call(AUTH, {"query": "x"}, _deps(r))
    assert out["text_available"] is True


def test_degraded_candidates_are_dropped():
    # 契约:degraded 块仅全文检索、不参与条款级引用。
    r = FakeRetriever([FakeCandidate("c1"), FakeCandidate("c2", degraded=True)])
    out = search_policy.call(AUTH, {"query": "x"}, _deps(r))
    assert [h["clause_id"] for h in out["hits"]] == ["c1"]


def test_missing_query_is_a_param_error():
    r = FakeRetriever([])
    with pytest.raises(ScopeError) as e:
        search_policy.call(AUTH, {}, _deps(r))
    assert e.value.code == -32602
    assert "query" in e.value.message


def test_blank_query_is_a_param_error():
    r = FakeRetriever([])
    with pytest.raises(ScopeError) as e:
        search_policy.call(AUTH, {"query": "   "}, _deps(r))
    assert e.value.code == -32602


def test_schema_declares_no_mode_parameter():
    # 主规格 §2.2 的 T1 声明了 mode: "hybrid"|"hyde",但底层实现不了 ——
    # Retriever.retrieve() 无 mode 参数,HyDE 由构造期注入的 _hyde_llm 控制
    # (hybrid.py:97-99,168,208),不是 per-call 的。
    # 声明一个不起作用的参数比不声明更糟:模型会以为自己切换了检索策略。
    assert "mode" not in search_policy.TOOL.input_schema["properties"]


def test_description_teaches_the_model_to_rewrite_colloquial_queries():
    # mode:"hyde" 的意图没有丢,只是从服务端挪到了模型侧。
    assert "改写" in search_policy.TOOL.description


def test_invalid_include_superseded_is_a_param_error():
    r = FakeRetriever([])
    with pytest.raises(ScopeError) as e:
        search_policy.call(AUTH, {"query": "x", "include_superseded": "yes"}, _deps(r))
    assert e.value.code == -32602
    assert "include_superseded" in e.value.message


def test_zero_hits_is_not_an_error():
    # 命中 0 条不是错误(规格 §2.4)。返回空数组,让模型自己决定是换词还是拒答。
    r = FakeRetriever([])
    out = search_policy.call(AUTH, {"query": "x"}, _deps(r))
    assert out["hits"] == []
    assert out["total"] == 0


def test_records_clause_ids_into_the_run_allowlist():
    # T4 的前置:只有本 run 检索过的 id 才能取详情(规格 §3.3)。
    reg = RunRegistry()
    r = FakeRetriever([FakeCandidate("c1"), FakeCandidate("c2")])
    search_policy.call(AUTH, {"query": "x"}, _deps(r, reg))
    assert reg.allowed("r-1") == {"c1", "c2"}


def test_dropped_degraded_ids_are_not_recorded():
    # 没返回给模型的 id 不该进白名单 —— 否则模型「猜」一个 id 也能取到详情。
    reg = RunRegistry()
    r = FakeRetriever([FakeCandidate("c1"), FakeCandidate("c2", degraded=True)])
    search_policy.call(AUTH, {"query": "x"}, _deps(r, reg))
    assert reg.allowed("r-1") == {"c1"}


def test_tool_schema_hides_the_authorization_layer():
    # 规格 §2.3:授权层不出现在任何工具的 JSON Schema 里,agent 既看不见也填不了。
    # 这是权限红线的**结构性**保证,不是编码风格。
    props = search_policy.TOOL.input_schema["properties"]
    for forbidden in ("perm_tags", "corpus_types", "run_id"):
        assert forbidden not in props


def test_tool_schema_has_no_top_k():
    # 三个 retrieve* 都没有 top_k(探针条 3);给 agent 一个无效参数比不给更糟。
    assert "top_k" not in search_policy.TOOL.input_schema["properties"]


def test_tool_description_tells_the_model_text_may_be_null():
    # 当前环境 text 恒 null。description 不说清,模型就会拿 null 当「没有正文」。
    assert "get_clause_detail" in search_policy.TOOL.description
