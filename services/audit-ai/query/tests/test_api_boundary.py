"""audit-biz 边界二 ``POST /v1/query``:无身份、无状态、JSON 响应、前置过滤。"""

from __future__ import annotations

from contextlib import contextmanager

from fastapi.testclient import TestClient

from query.api.app import create_app
from query.contract import (
    AnswerBlock,
    BlockType,
    Citation,
    ClauseHit,
    QueryResult,
    RegulationHit,
    RouteType,
    StructuredResult,
    TabPayload,
)
from query.retrieve.hybrid import Candidate


def _cand(cid, score):
    return Candidate(cid, score, "P-INT", "DV1", "1/1", 1, False, "hybrid",
                     source_code=f"LC-{cid}", source_doc_id=f"LB-{cid}")


class _Agent:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def ask(self, query, history=None, *, trace_id=None):
        self.calls.append({"query": query, "history": history, "trace_id": trace_id})
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _Retriever:
    """scoped 桩:记录 scope,并向 collector 注入候选(模拟 ask 内检索发生在 scope 中)。"""

    def __init__(self, cands=()):
        self.scopes = []
        self.cands = list(cands)

    @contextmanager
    def scoped(self, **scope):
        self.scopes.append(scope)
        if scope.get("collector") is not None:
            scope["collector"].extend(self.cands)
        yield


class _Svc:
    def __init__(self, result=None, cands=()):
        self.agent = _Agent(result or _default_result())
        self.retriever = _Retriever(cands)
        self.case_detail_calls = []
        self.clause_detail_calls = []
        self.dm_clause_detail_calls = []
        self.structured_calls = []

    def structured_for(self, query, *, include_superseded=False):
        self.structured_calls.append({
            "query": query,
            "include_superseded": include_superseded,
        })
        return StructuredResult(
            regulations=TabPayload(items=[
                RegulationHit(1, "REG-1", "DV-1", "信息披露管理办法", 0.9, "信息披露要求"),
            ]),
            clauses=TabPayload(items=[
                ClauseHit(
                    1, "c1", "第五条", "信息披露管理办法", "DV-1", 0.8,
                    source_code="LC-c1", source_doc_id="LB-c1",
                ),
            ]),
            regulatory_rules=TabPayload(items=[]),
            cases=TabPayload(items=[]),
        )

    def case_detail(self, case_id, perm_tags):
        self.case_detail_calls.append((case_id, perm_tags))
        if case_id == "CASE-404":
            return None
        return {
            "case_id": case_id,
            "case_name": "信息披露违规案例",
            "regulator": "中国证监会",
            "penalty_date": "2024-01-08",
            "violation_topic": "信息披露",
            "related_regulation": "上市公司信息披露管理办法",
            "core_issue": "信息披露内容违法",
            "insight": "完善披露复核流程",
            "full_text": "案例完整正文",
            "source_url": None,
        }

    def clause_detail(self, clause_id, perm_tags):
        self.clause_detail_calls.append((clause_id, perm_tags))
        if clause_id == "CLAUSE-404":
            return None
        return {
            "clause_id": clause_id,
            "doc_title": "北京证券交易所上市公司证券发行上市审核规则",
            "clause_path": "第二章/第十七条",
            "full_text": "第十七条完整正文，不应按检索摘要长度截断。",
        }

    def dm_clause_detail(self, source_code, source_doc_id):
        self.dm_clause_detail_calls.append((source_code, source_doc_id))
        if source_code == "SOURCE-404":
            return None
        return {
            "clause_id": source_code,
            "source_code": source_code,
            "source_doc_id": source_doc_id,
            "doc_title": "达梦制度原文",
            "full_text": "这是从达梦源库回查的完整条款正文。",
        }


def _default_result():
    return QueryResult(
        route_type=RouteType.EVIDENCE,
        answer_blocks=[AnswerBlock(BlockType.TEXT, "答复")],
        citations=[Citation("c1", doc_title="不应出边界")],
        confidence=0.8,
    )


def _client(monkeypatch, svc=None):
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "secret")
    return TestClient(create_app(service=svc or _Svc()))


def _body(**overrides):
    body = {
        "query": "客户适当性依据",
        "request_id": "REQ-1",
        "filters": {
            "perm_tags": ["内部"],
            "corpus_types": ["internal"],
            "project_id": None,
            "owner": "ignored-for-regulations",
        },
        "options": {"top_k": 5, "include_superseded": True},
    }
    body.update(overrides)
    return body


_HDR = {"X-Internal-Token": "secret"}


# ── 鉴权(B104,无身份,fail-closed)─────────────────────────────────────────
def test_boundary_requires_internal_token(monkeypatch):
    c = _client(monkeypatch)
    r = c.post("/v1/query", json=_body())
    assert r.status_code == 401
    assert r.json() == {"error": {"code": "B104", "message": "内部令牌无效"}}


def test_boundary_env_unset_is_fail_closed(monkeypatch):
    monkeypatch.delenv("AUDIT_AI_INTERNAL_TOKEN", raising=False)
    c = TestClient(create_app(service=_Svc()))
    r = c.post("/v1/query", json=_body(), headers={"X-Internal-Token": "anything"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "B104"


def test_boundary_case_detail_uses_internal_token_and_permission_scope(monkeypatch):
    svc = _Svc()
    r = _client(monkeypatch, svc).post(
        "/v1/cases/CASE-1",
        json={"filters": {"perm_tags": ["公开"]}},
        headers=_HDR,
    )

    assert r.status_code == 200
    assert r.json()["case_id"] == "CASE-1"
    assert r.json()["full_text"] == "案例完整正文"
    assert svc.case_detail_calls == [("CASE-1", ["公开"])]


def test_boundary_case_detail_hides_missing_or_out_of_scope_case(monkeypatch):
    r = _client(monkeypatch).post(
        "/v1/cases/CASE-404",
        json={"filters": {"perm_tags": ["公开"]}},
        headers=_HDR,
    )

    assert r.status_code == 404
    assert r.json()["error"]["code"] == "NOT_FOUND"


def test_boundary_clause_detail_uses_internal_token_and_permission_scope(monkeypatch):
    svc = _Svc()
    r = _client(monkeypatch, svc).post(
        "/v1/clauses/CLAUSE-1",
        json={"filters": {"perm_tags": ["公开"]}},
        headers=_HDR,
    )

    assert r.status_code == 200
    assert r.json()["clause_id"] == "CLAUSE-1"
    assert r.json()["full_text"] == "第十七条完整正文，不应按检索摘要长度截断。"
    assert svc.clause_detail_calls == [("CLAUSE-1", ["公开"])]


def test_boundary_clause_detail_hides_missing_or_out_of_scope_clause(monkeypatch):
    r = _client(monkeypatch).post(
        "/v1/clauses/CLAUSE-404",
        json={"filters": {"perm_tags": ["公开"]}},
        headers=_HDR,
    )

    assert r.status_code == 404
    assert r.json()["error"]["code"] == "NOT_FOUND"


def test_boundary_dm_clause_detail_uses_both_source_codes(monkeypatch):
    svc = _Svc()
    r = _client(monkeypatch, svc).post(
        "/v1/dm/clauses/SOURCE-1",
        json={"source_doc_id": "DOC-1"},
        headers=_HDR,
    )

    assert r.status_code == 200
    assert r.json()["source_code"] == "SOURCE-1"
    assert r.json()["full_text"] == "这是从达梦源库回查的完整条款正文。"
    assert svc.dm_clause_detail_calls == [("SOURCE-1", "DOC-1")]


# ── JSON 映射 + 轻量引用 + request_id 贯穿 ─────────────────────────────────
def test_boundary_json_maps_query_result(monkeypatch):
    svc = _Svc(cands=[_cand("c1", 0.9), _cand("c2", 0.1)])
    r = _client(monkeypatch, svc).post("/v1/query", json=_body(), headers=_HDR)
    assert r.status_code == 200
    assert "application/json" in r.headers["content-type"]
    data = r.json()
    assert {key: value for key, value in data["meta"].items() if key != "elapsed_ms"} == {
        "request_id": "REQ-1", "route_type": "evidence",
        "ai_label": True, "review_required": False, "export_enabled": True,
    }
    assert data["meta"]["elapsed_ms"] >= 0
    assert data["answer_blocks"] == [
        {"block_seq": 0, "block_type": "text", "content": "答复"}
    ]
    # 轻量引用:clause_id/chunk_id/score + DM 回查键 source_code/source_doc_id(取自候选=Milvus hit,
    # 非 PG 回查);不泄 doc_title/page/version 等 PG 展示字段。score 来自 collector(c1=0.9 max→1.0)。
    assert data["citations"] == [{
        "clause_id": "c1", "chunk_id": "c1", "score": 1.0,
        "source_code": "LC-c1", "source_doc_id": "LB-c1",  # CP-010:DM CODE 随候选流到帧
    }]
    assert data["structured"]["regulations"]["total"] == 1
    assert data["structured"]["regulations"]["items"][0]["title"] == "信息披露管理办法"
    assert data["structured"]["clauses"]["total"] == 1
    assert data["structured"]["clauses"]["items"][0]["source_code"] == "LC-c1"
    assert data["structured"]["clauses"]["items"][0]["source_doc_id"] == "LB-c1"
    assert data["completion"] == {"finish_reason": "stop", "confidence": 0.8, "exhausted_scope": []}
    assert svc.agent.calls[0]["trace_id"] == "REQ-1"
    assert svc.structured_calls == [{"query": "客户适当性依据", "include_superseded": True}]


def test_boundary_citation_score_null_when_not_in_collected(monkeypatch):
    svc = _Svc(cands=[_cand("other", 0.5)])
    r = _client(monkeypatch, svc).post("/v1/query", json=_body(), headers=_HDR)
    assert r.json()["citations"][0]["score"] is None  # 契约 nullable:biz 降级不显匹配度


def test_boundary_refusal_maps_finish_reason(monkeypatch):
    result = QueryResult(
        route_type=RouteType.REFUSE, answer_blocks=[AnswerBlock(BlockType.TEXT, "拒答")],
        citations=[], confidence=0.0, exhausted_scope=["现行制度"],
    )
    r = _client(monkeypatch, _Svc(result=result)).post("/v1/query", json=_body(), headers=_HDR)
    data = r.json()
    assert data["completion"]["finish_reason"] == "refused"
    assert data["completion"]["exhausted_scope"] == ["现行制度"]
    assert data["citations"] == []


# ── 过滤位下推(检索前生效)───────────────────────────────────────────────
def test_boundary_filters_are_scoped_before_retrieval(monkeypatch):
    svc = _Svc()
    _client(monkeypatch, svc).post("/v1/query", json=_body(), headers=_HDR)
    scope = svc.retriever.scopes[0]
    assert scope["corpora"] == ("P-INT",)
    assert scope["topk"] == 5
    assert scope["include_superseded"] is True  # 契约位对答案路径生效(非仅分数旁路)
    assert scope["extra_expr"] == 'array_contains_any(perm_tag, ["内部"])'
    assert "owner" not in scope["extra_expr"]  # owner 不作用于制度语料(契约明文忽略)
    assert isinstance(scope["collector"], list)
    structured_scope = svc.retriever.scopes[1]
    assert structured_scope["corpora"] == ("P-INT",)
    assert structured_scope["extra_expr"] == scope["extra_expr"]
    assert "collector" not in structured_scope


def test_boundary_empty_perm_tags_means_no_extra_filter(monkeypatch):
    svc = _Svc()
    body = _body()
    body["filters"]["perm_tags"] = []  # 契约:空数组 = 无额外限制(字段必填但可空)
    _client(monkeypatch, svc).post("/v1/query", json=body, headers=_HDR)
    assert svc.retriever.scopes[0]["extra_expr"] is None


def test_boundary_qa_and_case_corpora_map_to_partitions(monkeypatch):
    svc = _Svc()
    body = _body()
    body["filters"]["corpus_types"] = ["qa", "case"]
    _client(monkeypatch, svc).post("/v1/query", json=body, headers=_HDR)
    assert svc.retriever.scopes[0]["corpora"] == ("P-QA", "P-CASE")


# ── 校验:显式 422,绝不静默零命中 ─────────────────────────────────────────
def test_boundary_rejects_audit_project_even_without_project_id(monkeypatch):
    for extra in ({"project_id": "P1", "owner": "u1"}, {"project_id": None, "owner": None}):
        body = _body(filters={"perm_tags": [], "corpus_types": ["audit_project"], **extra})
        r = _client(monkeypatch).post("/v1/query", json=body, headers=_HDR)
        assert r.status_code == 422
        assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_boundary_rejects_empty_corpus_types(monkeypatch):
    body = _body(filters={"perm_tags": [], "corpus_types": []})
    r = _client(monkeypatch).post("/v1/query", json=body, headers=_HDR)
    assert r.status_code == 422


# ── JSON 错误响应(码在契约 B 段词表内)─────────────────────────────────────
def test_boundary_error_response_uses_contract_code(monkeypatch):
    svc = _Svc(result=RuntimeError("boom"))
    r = _client(monkeypatch, svc).post("/v1/query", json=_body(), headers=_HDR)
    assert r.status_code == 500
    assert r.json() == {"error": {"code": "B105", "message": "生成失败"}}


# ── Retriever.scoped:过滤真下推 Milvus + 复位 + 收集 ─────────────────────────
class _Emb:
    dense = [0.1]
    sparse = {1: 1.0}


class _Embed:
    def embed(self, texts):
        return [_Emb()]


class _Milvus:
    def __init__(self, hits=()):
        self.calls = []
        self.hits = list(hits)

    def search(self, dense, sparse, **kw):
        self.calls.append(kw)
        return type("R", (), {"hits": self.hits, "retrieval_mode": "hybrid"})()


def _retriever(milvus):
    from query.config import QueryConfig
    from query.retrieve.hybrid import Retriever

    return Retriever(_Embed(), milvus, QueryConfig(decompose=False, hyde=False))


def test_retriever_scope_threads_filter_to_milvus_and_resets():
    milvus = _Milvus()
    retriever = _retriever(milvus)
    collected = []
    with retriever.scoped(
        corpora=("P-INT",), extra_expr='array_contains_any(perm_tag, ["内部"])',
        topk=3, partition_topk=3, include_superseded=True, collector=collected,
    ):
        assert retriever.retrieve("q") == []
    assert milvus.calls == [{
        "topk": 3,
        "include_superseded": True,   # scope 契约位覆盖缺省(答案路径生效)
        "corpus": "P-INT",
        "extra_expr": 'array_contains_any(perm_tag, ["内部"])',
        "with_text": False,
        "query_text": "q",           # CP-012:bm25 词法通道用 query 原文(bge 忽略)
    }]
    # 退出 scope 复位:回到既有双分区、无 extra_expr(byte 等价)
    retriever.retrieve("q")
    assert [c["corpus"] for c in milvus.calls[1:]] == ["P-INT", "P-EXT"]
    assert all(c["extra_expr"] is None for c in milvus.calls[1:])
    assert all(c["include_superseded"] is False for c in milvus.calls[1:])


def test_retriever_scope_collects_returned_candidates():
    hit = {"chunk_id": "c1", "score": 0.9, "corpus_type": "P-INT", "doc_version_id": "DV1",
           "clause_path": "1/1", "page_start": 1, "degraded": False}
    retriever = _retriever(_Milvus(hits=[hit]))
    collected = []
    with retriever.scoped(corpora=("P-INT",), collector=collected):
        out = retriever.retrieve("q")
    assert [c.chunk_id for c in out] == ["c1"]
    assert collected == out  # 收集的就是实际返回的候选(分数派生不二次检索)


def test_retriever_scope_qa_partition_reaches_main_retrieval():
    milvus = _Milvus()
    retriever = _retriever(milvus)
    with retriever.scoped(corpora=("P-QA",)):
        retriever.retrieve("q")
    assert [c["corpus"] for c in milvus.calls] == ["P-QA"]


def test_retriever_scope_gates_cases_and_enumerate():
    milvus = _Milvus()
    retriever = _retriever(milvus)
    with retriever.scoped(corpora=("P-INT",)):
        assert retriever.retrieve_cases("q") == []   # 不含 case → 整路跳过,零 Milvus 调用
        retriever.retrieve_enumerate("q")            # 枚举仅内/外规:交出 P-INT
    assert [c["corpus"] for c in milvus.calls] == ["P-INT"]

    milvus2 = _Milvus()
    retriever2 = _retriever(milvus2)
    with retriever2.scoped(corpora=("P-QA",)):       # 枚举不支持 QA → 空(上层覆盖拒答,刻意语义)
        assert retriever2.retrieve_enumerate("q") == []
    assert milvus2.calls == []


def test_retriever_scope_merges_extra_expr_for_enumerate():
    milvus = _Milvus()
    retriever = _retriever(milvus)
    with retriever.scoped(corpora=("P-EXT",), extra_expr='array_contains_any(perm_tag, ["公开"])'):
        retriever.retrieve_enumerate("q", extra_expr='chunk_type == "clause"')
    assert milvus.calls[0]["extra_expr"] == (
        'array_contains_any(perm_tag, ["公开"]) and chunk_type == "clause"'
    )
