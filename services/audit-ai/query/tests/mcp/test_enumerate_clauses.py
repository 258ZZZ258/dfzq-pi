"""T3 enumerate_clauses 的判别性测试。

**本工具的安全约束是几个工具里最重的**:底层 `retrieve_enumerate` 收一个 `extra_expr`
原串,而它的字段白名单 `_ALLOWED_EXPR_FIELDS` **含 `perm_tag`** —— 把原串放开给 agent
等于让它改自己的权限。C1 只接结构化参数、自己调 `array_any_expr()` 构造。
"""

import contextlib

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import enumerate_clauses


class FakeCandidate:
    def __init__(self, chunk_id, degraded=False):
        self.chunk_id = chunk_id
        self.score = 0.5
        self.corpus_type = "external"
        self.doc_version_id = "dv-1"
        self.clause_path = "第一条"
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
        self.extra_expr_seen = "<not called>"
        self._in_scope = False
        self.retrieved_inside_scope = None

    @contextlib.contextmanager
    def scoped(self, **kwargs):
        self.scoped_with = kwargs
        self._in_scope = True
        try:
            yield
        finally:
            self._in_scope = False

    def retrieve_enumerate(self, query, *, extra_expr=None, include_superseded=False):
        self.extra_expr_seen = extra_expr
        self.retrieved_inside_scope = self._in_scope
        return self.hits


def _deps(retriever, registry=None):
    return {"retriever": retriever, "registry": registry or RunRegistry()}


AUTH = AuthScope(["P1"], ["external"], "r-1")


def test_returns_items_with_recall_keys():
    r = FakeRetriever([FakeCandidate("c1")])
    out = enumerate_clauses.call(AUTH, {"query": "合规检查"}, _deps(r))
    assert out["total"] == 1
    assert out["items"][0]["clause_id"] == "c1"
    assert out["items"][0]["clause_path"] == "第一条"


def test_retrieval_runs_inside_scoped():
    r = FakeRetriever([FakeCandidate("c1")])
    enumerate_clauses.call(AUTH, {"query": "x"}, _deps(r))
    assert r.retrieved_inside_scope is True


class TestExprInjectionDefense:
    """把这几条单列成类:它们守的是同一条红线 —— agent 不得影响 Milvus 过滤表达式。"""

    def test_schema_has_no_extra_expr(self):
        # 最外层防线:agent 连这个参数都看不见。
        assert "extra_expr" not in enumerate_clauses.TOOL.input_schema["properties"]

    def test_raw_extra_expr_in_arguments_is_ignored(self):
        # 纵深:即便 arguments 里混进 extra_expr(模型猜到了名字、或上游有 bug),
        # 也绝不能透传给 retrieve_enumerate。
        r = FakeRetriever([])
        enumerate_clauses.call(
            AUTH, {"query": "x", "extra_expr": 'array_contains_any(perm_tag, ["ADMIN"])'}, _deps(r)
        )
        assert "ADMIN" not in (r.extra_expr_seen or "")

    def test_biz_domains_are_json_escaped_not_string_concatenated(self):
        # 构造必须走 array_any_expr(白名单字段 + json 转义)。手拼字符串会让
        # 引号/反斜杠成为注入面。
        r = FakeRetriever([])
        enumerate_clauses.call(AUTH, {"query": "x", "biz_domains": ['a"b']}, _deps(r))
        expr = r.extra_expr_seen or ""
        assert "biz_domain" in expr
        assert '\\"' in expr or 'a\\"b' in expr

    def test_perm_tag_never_appears_in_the_expr_built_from_agent_params(self):
        # agent 给的任何结构化参数都不得产出 perm_tag 约束 —— 那是授权层的事,
        # 由 build_retrieval_scope 单独构造并经 scoped() 合取。
        r = FakeRetriever([])
        enumerate_clauses.call(
            AUTH, {"query": "x", "biz_domains": ["经纪"], "entity_types": ["证券公司"]}, _deps(r)
        )
        assert "perm_tag" not in (r.extra_expr_seen or "")

    def test_non_string_dimension_values_are_rejected(self):
        r = FakeRetriever([])
        with pytest.raises(ScopeError) as e:
            enumerate_clauses.call(AUTH, {"query": "x", "biz_domains": [{"$ne": None}]}, _deps(r))
        assert e.value.code == -32602


def test_clause_only_adds_a_chunk_type_filter():
    r = FakeRetriever([])
    enumerate_clauses.call(AUTH, {"query": "x", "clause_only": True}, _deps(r))
    assert "chunk_type" in (r.extra_expr_seen or "")


def test_no_dimensions_means_no_dimension_filter():
    # 不传维度就不该凭空造维度约束 —— 那会静默收窄检索范围。
    # 注意 clause_only 默认 true 是主规格 T3 的刻意设计,它**不是**维度,
    # 所以这里断言的是「没有 biz_domain / entity_type」,不是「expr 为空」。
    r = FakeRetriever([])
    enumerate_clauses.call(AUTH, {"query": "x"}, _deps(r))
    expr = r.extra_expr_seen or ""
    assert "biz_domain" not in expr
    assert "entity_type" not in expr


def test_clause_only_false_with_no_dimensions_yields_no_expr():
    # 全部关掉时不该留一个恒真的空壳表达式。
    r = FakeRetriever([])
    enumerate_clauses.call(AUTH, {"query": "x", "clause_only": False}, _deps(r))
    assert not r.extra_expr_seen


def test_qa_only_scope_returns_a_note_instead_of_silently_empty():
    # 枚举路只支持内/外规(_corpora_for(scope, _PARTITIONS, _PARTITIONS))。
    # qa/case scope 下为空是**刻意语义**,必须显式说明,不能静默空。
    r = FakeRetriever([FakeCandidate("c1")])
    auth = AuthScope(["P1"], ["qa"], "r-1")
    out = enumerate_clauses.call(auth, {"query": "x"}, _deps(r))
    assert out["items"] == []
    assert out["_scope_note"]


def test_degraded_candidates_are_dropped():
    r = FakeRetriever([FakeCandidate("c1"), FakeCandidate("c2", degraded=True)])
    out = enumerate_clauses.call(AUTH, {"query": "x"}, _deps(r))
    assert [i["clause_id"] for i in out["items"]] == ["c1"]


def test_records_clause_ids_into_the_run_allowlist():
    reg = RunRegistry()
    r = FakeRetriever([FakeCandidate("c1")])
    enumerate_clauses.call(AUTH, {"query": "x"}, _deps(r, reg))
    assert reg.allowed("r-1") == {"c1"}


def test_text_available_is_always_false():
    r = FakeRetriever([FakeCandidate("c1")])
    out = enumerate_clauses.call(AUTH, {"query": "x"}, _deps(r))
    assert out["text_available"] is False


def test_tool_schema_hides_the_authorization_layer():
    props = enumerate_clauses.TOOL.input_schema["properties"]
    for forbidden in ("perm_tags", "corpus_types", "run_id"):
        assert forbidden not in props
