from __future__ import annotations

from types import SimpleNamespace

from query.mcp.scope import AuthScope
from query.mcp.session import RunRegistry
from query.mcp.tools import retrieve_external_candidates_batch, retrieve_internal_candidates_batch
from query.retrieve.hybrid import BatchRetrievalResult, Candidate

AUTH = AuthScope(perm_tags=["内部"], corpus_types=["internal"], run_id="run-1")


class FakeRetriever:
    def __init__(self) -> None:
        self.scopes: list[dict] = []

    def scoped(self, **scope):
        self.scopes.append(scope)

        class Scope:
            def __enter__(self):
                return None

            def __exit__(self, *_):
                return False

        return Scope()

    def retrieve_batch(self, queries, *, include_superseded=False):
        assert queries == ["外规第一条", "外规第二条"]
        assert include_superseded is False
        hit = Candidate("C-1", 0.91, "P-INT", "DV-1", "第三条", None, False, "hybrid")
        degraded = Candidate("C-X", 0.3, "P-INT", "DV-X", "第九条", None, True, "hybrid")
        return [
            BatchRetrievalResult(queries[0], [hit, degraded]),
            BatchRetrievalResult(queries[1], [], "检索失败"),
        ]


def test_returns_authoritative_internal_candidates_in_input_order_and_registers_only_returned_ids() -> None:
    registry = RunRegistry()
    retriever = FakeRetriever()
    out = retrieve_internal_candidates_batch.call(
        AUTH,
        {"clauses": [{"clause_path": "第一条", "text": "外规第一条"}, {"clause_path": "第二条", "text": "外规第二条"}]},
        {
            "retriever": retriever,
            "pg": object(),
            "registry": registry,
            "fetch_anchors": lambda _pg, _ids: {
                "C-1": SimpleNamespace(
                    doc_title="内规",
                    doc_no="内规〔2026〕1号",
                    clause_path="第三条",
                    source_code="INT-1",
                )
            },
            "fetch_texts": lambda _pg, _ids: {"C-1": "内规第三条正文"},
        },
    )

    assert out["total"] == 2
    assert out["items"][0]["query_index"] == 0
    assert out["items"][0]["candidates"] == [
        {
            "chunk_id": "C-1",
            "clause_path": "第三条",
            "doc_title": "内规",
            "doc_no": "内规〔2026〕1号",
            "text": "内规第三条正文",
            "source_code": "INT-1",
            "score": 0.91,
        }
    ]
    assert out["items"][1] == {"query_index": 1, "candidates": [], "error": "检索失败"}
    assert registry.allowed("run-1") == {"C-1"}
    assert retriever.scopes[0]["corpora"] == ("P-INT",)


def test_external_only_authorization_returns_one_empty_item_per_clause_without_retrieval() -> None:
    out = retrieve_internal_candidates_batch.call(
        AuthScope(perm_tags=[], corpus_types=["external"], run_id="run-x"),
        {"clauses": [{"text": "外规第一条"}]},
        {"retriever": None, "pg": object(), "registry": RunRegistry()},
    )
    assert out == {"items": [{"query_index": 0, "candidates": [], "error": None}], "total": 1}


def test_filters_internal_candidates_to_the_requested_target_effective_date_range() -> None:
    registry = RunRegistry()
    retriever = FakeRetriever()
    filtered_ids: list[tuple[list[str], object, object]] = []
    out = retrieve_internal_candidates_batch.call(
        AUTH,
        {
            "clauses": [{"text": "外规第一条"}, {"text": "外规第二条"}],
            "effective_from": "2026-01-01",
            "effective_to": "2026-12-31",
        },
        {
            "retriever": retriever,
            "pg": object(),
            "registry": registry,
            "filter_target_chunks": lambda _pg, ids, effective_from, effective_to: (
                filtered_ids.append((ids, effective_from, effective_to)) or set()
            ),
            "fetch_anchors": lambda _pg, _ids: {},
            "fetch_texts": lambda _pg, _ids: {},
        },
    )

    assert out["items"][0]["candidates"] == []
    assert filtered_ids == [(["C-1"], "2026-01-01", "2026-12-31")]
    assert "effective_date" in retriever.scopes[0]["extra_expr"]


def test_rejects_an_entire_batch_when_every_retrieval_failed() -> None:
    class AllFailedRetriever(FakeRetriever):
        def retrieve_batch(self, queries, *, include_superseded=False):
            return [BatchRetrievalResult(query, [], "嵌入失败") for query in queries]

    import pytest

    with pytest.raises(RuntimeError, match="all clause retrievals failed"):
        retrieve_internal_candidates_batch.call(
            AUTH,
            {"clauses": [{"text": "外规第一条"}, {"text": "外规第二条"}]},
            {
                "retriever": AllFailedRetriever(),
                "pg": object(),
                "registry": RunRegistry(),
                "fetch_anchors": lambda _pg, _ids: {},
                "fetch_texts": lambda _pg, _ids: {},
            },
        )


def test_returns_authoritative_external_candidates_from_p_ext() -> None:
    class ExternalRetriever(FakeRetriever):
        def retrieve_batch(self, queries, *, include_superseded=False, corpora=("P-INT",)):
            assert queries == ["内规第一条"]
            assert include_superseded is False
            assert corpora == ("P-EXT",)
            return [
                BatchRetrievalResult(
                    queries[0],
                    [Candidate("EXT-1", 0.92, "P-EXT", "DV-EXT", "第十条", None, False, "hybrid")],
                )
            ]

    registry = RunRegistry()
    out = retrieve_external_candidates_batch.call(
        AuthScope(perm_tags=["公开"], corpus_types=["external"], run_id="run-ext"),
        {"clauses": [{"clause_path": "第三条", "text": "内规第一条"}]},
        {
            "retriever": ExternalRetriever(),
            "pg": object(),
            "registry": registry,
            "fetch_anchors": lambda _pg, _ids: {
                "EXT-1": SimpleNamespace(doc_title="外规", doc_no="外规〔2026〕1号", clause_path="第十条", source_code="EXT-1")
            },
            "fetch_texts": lambda _pg, _ids: {"EXT-1": "外规第十条正文"},
        },
    )

    assert out["items"][0]["candidates"][0]["chunk_id"] == "EXT-1"
    assert out["items"][0]["candidates"][0]["text"] == "外规第十条正文"
    assert registry.allowed("run-ext") == {"EXT-1"}


def test_internal_only_authorization_returns_empty_external_items_without_retrieval() -> None:
    out = retrieve_external_candidates_batch.call(
        AuthScope(perm_tags=["内部"], corpus_types=["internal"], run_id="run-int"),
        {"clauses": [{"text": "内规第一条"}]},
        {"retriever": None, "pg": object(), "registry": RunRegistry()},
    )
    assert out == {"items": [{"query_index": 0, "candidates": [], "error": None}], "total": 1}
