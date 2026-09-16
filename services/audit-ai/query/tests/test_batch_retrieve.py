"""上传外规逐条比对的批量检索：批量嵌入、有限并发和逐条失败隔离。"""

from __future__ import annotations

import threading
import time

import pytest

from pipeline.index.embedding_client import Embedding
from pipeline.index.milvus_io import SearchResult
from query.config import QueryConfig
from query.retrieve.hybrid import BatchRetrievalResult, Retriever


class _BatchEmbed:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[Embedding]:
        self.calls.append(list(texts))
        return [Embedding(dense=[0.1], sparse={"1": 1.0}) for _ in texts]


class _ConcurrentMilvus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def search(
        self, dense, sparse, *, topk, include_superseded=False, corpus=None,
        extra_expr=None, with_text=False, query_text=None,
    ):
        if query_text == "失败条款":
            raise RuntimeError("simulated milvus failure")
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.03)
            return SearchResult(
                hits=[{
                    "chunk_id": f"{query_text}-{corpus}", "score": 0.9,
                    "corpus_type": corpus, "doc_version_id": "DV1",
                    "clause_path": "第一条", "degraded": False,
                }],
                retrieval_mode="hybrid",
            )
        finally:
            with self._lock:
                self.active -= 1


def _retriever():
    embed = _BatchEmbed()
    milvus = _ConcurrentMilvus()
    return Retriever(embed, milvus, QueryConfig()), embed, milvus


def test_retrieve_batch_embeds_once_runs_bounded_parallel_and_keeps_input_order():
    retriever, embed, milvus = _retriever()

    rows = retriever.retrieve_batch(["第一条", "第二条", "第三条"], max_concurrency=2)

    assert [row.query for row in rows] == ["第一条", "第二条", "第三条"]
    assert all(isinstance(row, BatchRetrievalResult) for row in rows)
    assert all(row.error is None for row in rows)
    assert all(row.candidates for row in rows)
    assert embed.calls == [["第一条", "第二条", "第三条"]]
    assert milvus.max_active == 2
    assert {candidate.corpus_type for row in rows for candidate in row.candidates} == {"P-INT"}


def test_retrieve_batch_isolates_one_clause_failure():
    retriever, _embed, _milvus = _retriever()

    rows = retriever.retrieve_batch(["第一条", "失败条款", "第三条"], max_concurrency=2)

    assert [row.query for row in rows] == ["第一条", "失败条款", "第三条"]
    assert rows[0].candidates and rows[0].error is None
    assert rows[1].candidates == []
    assert rows[1].error == "检索失败"
    assert rows[2].candidates and rows[2].error is None


def test_retrieve_batch_can_route_to_external_corpus():
    retriever, _embed, _milvus = _retriever()

    rows = retriever.retrieve_batch(["内规义务条款"], corpora=("P-EXT",))

    assert rows[0].candidates
    assert {candidate.corpus_type for candidate in rows[0].candidates} == {"P-EXT"}


def test_retrieve_batch_rejects_non_positive_concurrency():
    retriever, _embed, _milvus = _retriever()

    with pytest.raises(ValueError, match="max_concurrency"):
        retriever.retrieve_batch(["第一条"], max_concurrency=0)
