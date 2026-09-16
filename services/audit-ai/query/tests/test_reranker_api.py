"""APIReranker(Jina/Cohere 风远程 /rerank)单元:零网络(monkeypatch httpx.post)。

构造 fail-fast(缺 base_url)· 请求体契约(model/query/documents)· 按 relevance_score 降序重排 ·
top_n 截断时缺项候选补回原序(不丢候选)· 空候选/空结果 · make_reranker api 分支。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import query.rerank.reranker as rr
from query.config import QueryConfig
from query.rerank.reranker import APIReranker, make_reranker


def _c(cid, text):
    return SimpleNamespace(chunk_id=cid, text=text)


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _api(**kw):
    return APIReranker(base_url="http://gw.local/v1", model="bge-reranker-v2-m3", **kw)


def test_fails_fast_without_base_url():
    with pytest.raises(ValueError, match="base_url"):
        APIReranker(base_url=None, model="m")


def test_empty_candidates_passthrough():
    assert _api().rerank("q", []) == []


def test_request_contract_and_reorder(monkeypatch):
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        # 服务端乱序返回 → 客户端须按 score 降序
        return _FakeResp(
            {"results": [{"index": 0, "relevance_score": 0.1},
                         {"index": 2, "relevance_score": 0.9},
                         {"index": 1, "relevance_score": 0.5}]}
        )

    monkeypatch.setattr(rr.httpx, "post", fake_post)
    cands = [_c("a", "t0"), _c("b", "t1"), _c("c", "t2")]
    out = _api(api_key="sk-y").rerank("问题", cands)

    assert captured["url"] == "http://gw.local/v1/rerank"
    assert captured["json"]["model"] == "bge-reranker-v2-m3"
    assert captured["json"]["query"] == "问题"
    assert captured["json"]["documents"] == ["t0", "t1", "t2"]
    assert captured["headers"]["Authorization"] == "Bearer sk-y"
    assert [c.chunk_id for c in out] == ["c", "b", "a"]  # 0.9, 0.5, 0.1


def test_top_n_missing_candidates_appended_in_order(monkeypatch):
    # top_n 截断:服务端只返回 2 条 → 未返回的候选补回原序,不丢
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp(
            {"results": [
                {"index": 2, "relevance_score": 0.9},
                {"index": 0, "relevance_score": 0.4},
            ]}
        )

    monkeypatch.setattr(rr.httpx, "post", fake_post)
    cands = [_c("a", "t0"), _c("b", "t1"), _c("c", "t2")]
    out = _api(top_n=2).rerank("q", cands)
    assert [c.chunk_id for c in out] == ["c", "a", "b"]  # 重排 c,a;未返回的 b 补末尾


def test_top_n_sent_in_payload(monkeypatch):
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured["json"] = json
        return _FakeResp({"results": []})

    monkeypatch.setattr(rr.httpx, "post", fake_post)
    _api(top_n=5).rerank("q", [_c("a", "t0")])
    assert captured["json"]["top_n"] == 5


def test_empty_results_keeps_original_order(monkeypatch):
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"results": []})

    monkeypatch.setattr(rr.httpx, "post", fake_post)
    cands = [_c("a", "t0"), _c("b", "t1")]
    assert _api().rerank("q", cands) == cands  # 空结果不丢候选,保原序


def test_make_reranker_api_branch():
    qcfg = QueryConfig(
        rerank_backend="api",
        rerank_endpoint_base_url="http://gw.local/v1",
        rerank_model="bge-reranker-v2-m3",
    )
    assert isinstance(make_reranker(qcfg), APIReranker)


def test_make_reranker_api_without_base_url_fails():
    qcfg = QueryConfig(rerank_backend="api", rerank_endpoint_base_url=None)
    with pytest.raises(ValueError, match="base_url"):
        make_reranker(qcfg)
