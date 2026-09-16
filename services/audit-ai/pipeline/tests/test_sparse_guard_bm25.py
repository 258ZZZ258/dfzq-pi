"""T6(CP-012):静默降级护栏——bge 后端却拿空 sparse → fail-fast(不静默退 dense-only)。零栈。

bm25/none 不产客户端 sparse(Milvus 侧算 / 纯 dense),空 sparse 属正常,不校验。
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from pipeline.index.embedding_client import Embedding
from pipeline.stages.s5_embed_index import guard_sparse_backend


@dataclass
class _Chunk:
    chunk_id: str
    text: str


def _emb(sparse):
    return Embedding(dense=[0.1] * 1024, sparse=sparse)


def test_bge_empty_sparse_fails():
    with pytest.raises(RuntimeError, match="sparse"):
        guard_sparse_backend("bge", [_Chunk("c1", "证监会公告第十五号")], [_emb({})])


def test_bge_nonempty_sparse_ok():
    guard_sparse_backend("bge", [_Chunk("c1", "证监会公告")], [_emb({"1": 0.5})])  # 不抛


def test_bm25_empty_sparse_ok():
    # bm25:客户端不产 sparse(Milvus function 从 text 算),空 sparse 正常
    guard_sparse_backend("bm25", [_Chunk("c1", "证监会公告")], [_emb({})])


def test_none_empty_sparse_ok():
    guard_sparse_backend("none", [_Chunk("c1", "证监会公告")], [_emb({})])


def test_whitespace_text_empty_sparse_not_flagged():
    # 空白文本块 sparse 空不算误配(不误杀)
    guard_sparse_backend("bge", [_Chunk("c1", "   ")], [_emb({})])


def test_bge_fails_if_any_nonempty_text_lacks_sparse():
    chunks = [_Chunk("c1", "有正文"), _Chunk("c2", "另一条正文")]
    embs = [_emb({"1": 0.5}), _emb({})]  # c2 非空文本却空 sparse → 触发
    with pytest.raises(RuntimeError, match="c2"):
        guard_sparse_backend("bge", chunks, embs)
