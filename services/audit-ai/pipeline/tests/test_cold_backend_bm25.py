"""T7(CP-012):冷备按 backend 分形态——bge 需 dense+sparse,bm25/none 只需 dense。零栈。"""

from __future__ import annotations

from dataclasses import dataclass

from pipeline.index.corpus_rows import _cold_sparse, reloadable_chunks
from pipeline.index.milvus_io import sparse_to_bytes


@dataclass
class _Chunk:
    chunk_id: str = "c1"
    is_parent: bool = False
    dense_vec_cold: bytes | None = b"d"
    sparse_vec_cold: bytes | None = None


class _FakeDb:
    def __init__(self, chunks):
        self._chunks = chunks

    def get_chunks(self, dvid):
        return self._chunks


def test_cold_sparse_bge_deserializes():
    c = _Chunk(sparse_vec_cold=sparse_to_bytes({"1": 0.5}))
    assert _cold_sparse(c, "bge") == {"1": 0.5}


def test_cold_sparse_bm25_none_return_empty_without_deserialize():
    assert _cold_sparse(_Chunk(sparse_vec_cold=None), "bm25") == {}  # 不对 None 反序列化
    assert _cold_sparse(_Chunk(sparse_vec_cold=None), "none") == {}


def test_reloadable_bm25_only_needs_dense():
    chunks = [_Chunk(dense_vec_cold=b"d", sparse_vec_cold=None)]  # sparse 冷备缺
    assert len(reloadable_chunks(_FakeDb(chunks), "v", "bm25")) == 1  # dense 齐即可回灌
    assert len(reloadable_chunks(_FakeDb(chunks), "v", "none")) == 1
    assert len(reloadable_chunks(_FakeDb(chunks), "v", "bge")) == 0  # bge 缺 sparse → 不可回灌


def test_reloadable_excludes_missing_dense_all_backends():
    chunks = [_Chunk(dense_vec_cold=None, sparse_vec_cold=b"s")]  # dense 缺(staging 未嵌入)
    for sb in ("bge", "bm25", "none"):
        assert len(reloadable_chunks(_FakeDb(chunks), "v", sb)) == 0


def test_reloadable_excludes_parent():
    chunks = [_Chunk(is_parent=True, dense_vec_cold=b"d", sparse_vec_cold=b"s")]
    assert len(reloadable_chunks(_FakeDb(chunks), "v", "bge")) == 0
