"""EndpointClient(BGE 系远程 dense+sparse 嵌入)单元:零网络(monkeypatch httpx.post)。

构造 fail-fast(缺 base_url)· 请求体契约(model/input/return_dense/return_sparse)· dense+sparse
解析映射 Embedding · sparse 两形态(dict{token_id:权重} / [{index,value}] TEI 风)· batch 分批 ·
字段可配(dense/sparse field 名)· 空输入。全部注入 fake 响应,绝不发真请求。
"""

from __future__ import annotations

import pytest

import pipeline.index.embedding_client as ec
from pipeline.config import load_config
from pipeline.index.embedding_client import Embedding, EndpointClient


class _FakeResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:  # 2xx
        return None

    def json(self) -> dict:
        return self._payload


def _endpoint_cfg(**overrides):
    cfg = load_config().embedding.model_copy(
        update={"mode": "endpoint", "endpoint_base_url": "http://gw.local/v1", **overrides}
    )
    return cfg


def test_fails_fast_without_base_url():
    # mode=endpoint 但缺 base_url → 构造即抛(不留到 embed 才崩)
    cfg = load_config().embedding.model_copy(update={"mode": "endpoint", "endpoint_base_url": None})
    with pytest.raises(ValueError, match="base_url"):
        EndpointClient(cfg)


def test_empty_returns_empty():
    assert EndpointClient(_endpoint_cfg()).embed([]) == []


def test_request_contract_and_parse(monkeypatch):
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return _FakeResp(
            {
                "data": [
                    {"index": 0, "embedding": [0.1, 0.2], "sparse_embedding": {"5": 0.9, "7": 0.3}},
                    {"index": 1, "embedding": [0.3, 0.4], "sparse_embedding": {"9": 0.5}},
                ]
            }
        )

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    cfg = _endpoint_cfg(endpoint_api_key="sk-x", endpoint_model="bge-m3")
    out = EndpointClient(cfg).embed(["a", "b"])

    # 请求体契约
    assert captured["url"] == "http://gw.local/v1/embeddings"
    assert captured["json"]["model"] == "bge-m3"
    assert captured["json"]["input"] == ["a", "b"]
    assert captured["json"]["return_dense"] is True
    assert captured["json"]["return_sparse"] is True
    assert captured["headers"]["Authorization"] == "Bearer sk-x"
    # 解析映射
    assert out == [
        Embedding(dense=[0.1, 0.2], sparse={"5": 0.9, "7": 0.3}),
        Embedding(dense=[0.3, 0.4], sparse={"9": 0.5}),
    ]


def test_endpoint_model_falls_back_to_model_name(monkeypatch):
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured["model"] = json["model"]
        return _FakeResp({"data": [{"index": 0, "embedding": [1.0], "sparse_embedding": {}}]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    cfg = _endpoint_cfg(model_name="BAAI/bge-m3", endpoint_model=None)
    EndpointClient(cfg).embed(["x"])
    assert captured["model"] == "BAAI/bge-m3"  # endpoint_model=None → 回落 model_name


def test_sparse_list_form_tei(monkeypatch):
    # TEI 风 sparse: [{"index": int, "value": float}] → 归一 dict[str,float]
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp(
            {"data": [{"index": 0, "embedding": [1.0], "sparse": [{"index": 5, "value": 0.8}]}]}
        )

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    cfg = _endpoint_cfg(endpoint_sparse_field="sparse")
    out = EndpointClient(cfg).embed(["x"])
    assert out[0].sparse == {"5": 0.8}


def test_configurable_dense_field(monkeypatch):
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"data": [{"index": 0, "dense_vecs": [2.0, 3.0], "sparse_embedding": {}}]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    cfg = _endpoint_cfg(endpoint_dense_field="dense_vecs")
    out = EndpointClient(cfg).embed(["x"])
    assert out[0].dense == [2.0, 3.0]


def test_batches_by_batch_size(monkeypatch):
    calls = []

    def fake_post(url, *, headers, json, timeout):
        calls.append(list(json["input"]))
        return _FakeResp(
            {"data": [{"index": i, "embedding": [float(i)], "sparse_embedding": {}}
                      for i in range(len(json["input"]))]}
        )

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    cfg = _endpoint_cfg(batch_size=2)
    out = EndpointClient(cfg).embed(["a", "b", "c"])
    assert calls == [["a", "b"], ["c"]]  # 3 条 / batch=2 → 两批
    assert len(out) == 3


def test_missing_dense_field_raises(monkeypatch):
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"data": [{"index": 0, "sparse_embedding": {}}]})  # 无 embedding

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="dense"):
        EndpointClient(_endpoint_cfg()).embed(["x"])


def test_row_count_mismatch_raises(monkeypatch):
    def fake_post(url, *, headers, json, timeout):
        # 只返回 1 条 → 与请求 2 条不符
        return _FakeResp({"data": [{"index": 0, "embedding": [1.0], "sparse_embedding": {}}]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="条数"):
        EndpointClient(_endpoint_cfg()).embed(["x", "y"])  # 请求 2 条


def test_out_of_order_index_realigned(monkeypatch):
    # 服务端乱序返回 → 按 index 复位,向量与输入序严格对齐(不错配)
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"data": [
            {"index": 1, "embedding": [1.0], "sparse_embedding": {}},
            {"index": 0, "embedding": [0.0], "sparse_embedding": {}},
        ]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    out = EndpointClient(_endpoint_cfg()).embed(["a", "b"])
    assert out[0].dense == [0.0] and out[1].dense == [1.0]  # index 0→"a"、1→"b"


def test_duplicate_index_raises(monkeypatch):
    # index 重复(0,0)→ 非完整排列,拒绝(否则某输入的向量被覆盖/错配)
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"data": [
            {"index": 0, "embedding": [1.0], "sparse_embedding": {}},
            {"index": 0, "embedding": [2.0], "sparse_embedding": {}},
        ]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="排列"):
        EndpointClient(_endpoint_cfg()).embed(["a", "b"])


def test_index_gap_raises(monkeypatch):
    # index 缺号(0,2 缺 1)→ 拒绝
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"data": [
            {"index": 0, "embedding": [1.0], "sparse_embedding": {}},
            {"index": 2, "embedding": [2.0], "sparse_embedding": {}},
        ]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="排列"):
        EndpointClient(_endpoint_cfg()).embed(["a", "b"])


def test_partial_index_raises(monkeypatch):
    # 部分条目有 index、部分没有 → 无法可靠对齐,拒绝
    def fake_post(url, *, headers, json, timeout):
        return _FakeResp({"data": [
            {"index": 0, "embedding": [1.0], "sparse_embedding": {}},
            {"embedding": [2.0], "sparse_embedding": {}},
        ]})

    monkeypatch.setattr(ec.httpx, "post", fake_post)
    with pytest.raises(ValueError, match="index"):
        EndpointClient(_endpoint_cfg()).embed(["a", "b"])
