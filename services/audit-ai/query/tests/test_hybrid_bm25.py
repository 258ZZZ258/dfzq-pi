"""T5(CP-012):hybrid.py 向 milvus_io.search 透传 query_text(bm25 词法通道用 query 原文)。零栈。

三条主检索路(_search_candidates / retrieve_enumerate / retrieve_cases)都须把 query 原文作 query_text
传给 search;bge 忽略该参(byte 等价),bm25 据它算 BM25。用假 embed + 记录型 milvus。
"""

from __future__ import annotations

from pipeline.index.embedding_client import Embedding
from pipeline.index.milvus_io import SearchResult
from query.config import load_query_config
from query.retrieve.hybrid import Retriever


class _FakeEmbed:
    def embed(self, texts):
        return [Embedding(dense=[0.1] * 1024, sparse={"1": 0.5}) for _ in texts]


class _RecordingMilvus:
    def __init__(self):
        self.calls = []

    def search(
        self, dense, sparse, *, topk, include_superseded=False, corpus=None,
        extra_expr=None, with_text=False, query_text=None,
    ):
        self.calls.append({"corpus": corpus, "query_text": query_text})
        return SearchResult(hits=[], retrieval_mode="hybrid")


def _retriever(milvus):
    return Retriever(_FakeEmbed(), milvus, load_query_config())


def test_search_candidates_threads_query_text():
    milvus = _RecordingMilvus()
    _retriever(milvus)._search_candidates("证监会公告第十五号", corpora=("P-INT",))
    assert milvus.calls
    assert all(c["query_text"] == "证监会公告第十五号" for c in milvus.calls)


def test_enumerate_threads_query_text():
    milvus = _RecordingMilvus()
    _retriever(milvus).retrieve_enumerate("枚举查询")
    assert milvus.calls
    assert all(c["query_text"] == "枚举查询" for c in milvus.calls)


def test_cases_threads_query_text():
    milvus = _RecordingMilvus()
    _retriever(milvus).retrieve_cases("案例查询")
    assert milvus.calls
    assert all(c["query_text"] == "案例查询" for c in milvus.calls)
