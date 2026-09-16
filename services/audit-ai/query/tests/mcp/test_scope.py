"""policy-query-mcp 授权层的判别性测试。

红线(规格 §0):算在 Java、用在 Python;fail-closed 无 scope 即拒绝。
本文件每一条都对应一个具体的越权或误拒向量,不是形状检查。
"""

import pytest

from query.mcp.scope import AuthScope, ScopeError, build_retrieval_scope, parse_auth


def _args(**over):
    base = {"perm_tags": ["P1"], "corpus_types": ["external"], "run_id": "r-1"}
    base.update(over)
    return base


class TestParseAuth:
    def test_parses_a_complete_scope(self):
        auth = parse_auth(_args())
        assert auth == AuthScope(perm_tags=["P1"], corpus_types=["external"], run_id="r-1")

    @pytest.mark.parametrize("missing", ["perm_tags", "corpus_types", "run_id"])
    def test_missing_key_is_fail_closed(self, missing):
        args = _args()
        del args[missing]
        with pytest.raises(ScopeError) as e:
            parse_auth(args)
        assert e.value.code == -32000
        assert "missing authorization scope" in e.value.message

    def test_empty_corpus_types_is_fail_closed(self):
        with pytest.raises(ScopeError) as e:
            parse_auth(_args(corpus_types=[]))
        assert e.value.code == -32000

    def test_empty_perm_tags_is_allowed_not_fail_open(self):
        # 契约明文:perm_tags 空数组 = 无额外限制(routes_boundary.py:39-40)。
        # 这与「缺键」是两件事 —— 缺键上面那条已判为拒绝。改这条等于改边界契约。
        auth = parse_auth(_args(perm_tags=[]))
        assert auth.perm_tags == []

    def test_audit_project_gets_its_own_code(self):
        with pytest.raises(ScopeError) as e:
            parse_auth(_args(corpus_types=["external", "audit_project"]))
        # 合法枚举值但未接入 —— 不得与「未授权」同码,否则调用方分不清
        # 该去申请授权还是该等我们接入。
        assert e.value.code == -32602
        assert e.value.code != -32000

    def test_unknown_corpus_type_is_rejected(self):
        with pytest.raises(ScopeError) as e:
            parse_auth(_args(corpus_types=["nonesuch"]))
        assert e.value.code == -32602

    def test_blank_run_id_is_fail_closed(self):
        # 空串 run_id 会让 per-run 白名单退化成一个全局桶(规格 §3.3),
        # 池化后两个并发 run 就能互取对方的条款详情。
        with pytest.raises(ScopeError) as e:
            parse_auth(_args(run_id=""))
        assert e.value.code == -32000

    def test_non_list_perm_tags_is_fail_closed(self):
        # 形状合法但类型不对 = 伪装成合法请求的授权探测。
        with pytest.raises(ScopeError) as e:
            parse_auth(_args(perm_tags="P1"))
        assert e.value.code == -32000


class TestBuildRetrievalScope:
    def test_maps_corpus_types_to_milvus_partitions(self):
        s = build_retrieval_scope(AuthScope(["P1"], ["internal", "external"], "r-1"))
        assert set(s["corpora"]) == {"P-INT", "P-EXT"}

    def test_perm_tags_become_an_extra_expr(self):
        s = build_retrieval_scope(AuthScope(["P1", "P2"], ["external"], "r-1"))
        assert "perm_tag" in (s["extra_expr"] or "")
        assert "P1" in s["extra_expr"]

    def test_empty_perm_tags_produce_no_expr(self):
        # 空 = 无额外限制。绝不能变成一个恒假的表达式(那会静默零命中)。
        s = build_retrieval_scope(AuthScope([], ["external"], "r-1"))
        assert not s["extra_expr"]

    def test_passes_through_query_options(self):
        s = build_retrieval_scope(
            AuthScope([], ["external"], "r-1"), {"topK": 5, "includeSuperseded": True}
        )
        assert s["topk"] == 5
        assert s["include_superseded"] is True

    def test_absent_options_do_not_invent_limits(self):
        # topk=None ⇒ 用 qcfg 的默认;传 0 或别的臆造值会悄悄改变检索行为。
        s = build_retrieval_scope(AuthScope([], ["external"], "r-1"))
        assert s["topk"] is None
        assert s["include_superseded"] is False
