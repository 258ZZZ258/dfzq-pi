"""T2(CP-012):sparse_backend 配置缝 add-only + BM25/analyzer 参数默认。零栈。

- 默认 sparse_backend="bge"(现状,byte 等价);env PIPELINE_SPARSE_BACKEND 覆盖;非法值 fail-fast。
- BM25 index 参数(analyzer_type/k1/b)默认占位(⚠ V0)。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from pipeline.config import load_config


def test_sparse_backend_defaults_bge(monkeypatch):
    monkeypatch.delenv("PIPELINE_SPARSE_BACKEND", raising=False)
    cfg = load_config()
    assert cfg.embedding.sparse_backend == "bge"  # 默认 = 现状(byte 等价)


def test_sparse_backend_env_override_bm25(monkeypatch):
    monkeypatch.setenv("PIPELINE_SPARSE_BACKEND", "bm25")
    cfg = load_config()
    assert cfg.embedding.sparse_backend == "bm25"


def test_sparse_backend_env_override_none(monkeypatch):
    monkeypatch.setenv("PIPELINE_SPARSE_BACKEND", "none")
    cfg = load_config()
    assert cfg.embedding.sparse_backend == "none"


def test_sparse_backend_invalid_fail_fast(monkeypatch):
    monkeypatch.setenv("PIPELINE_SPARSE_BACKEND", "splade")
    with pytest.raises(ValidationError):  # 非法值:pydantic Literal 校验 → fail-fast
        load_config()


def test_bm25_index_params_defaults(monkeypatch):
    monkeypatch.delenv("PIPELINE_SPARSE_BACKEND", raising=False)
    cfg = load_config()
    assert cfg.milvus.bm25_analyzer_type == "chinese"
    assert cfg.milvus.bm25_k1 == pytest.approx(1.2)
    assert cfg.milvus.bm25_b == pytest.approx(0.75)
