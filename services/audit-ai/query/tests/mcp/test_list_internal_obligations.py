from __future__ import annotations

from datetime import date

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import list_internal_obligations

AUTH = AuthScope(perm_tags=["内部"], corpus_types=["internal"], run_id="run-1")


def _row(chunk_id: str = "C-1") -> dict:
    return {
        "chunk_id": chunk_id,
        "clause_path": "第一章 > 第三条",
        "doc_title": "合同管理办法",
        "doc_no": "内规〔2026〕1号",
        "deontic_type": "应当",
        "evidence": "应当",
        "text": "合同应当经法务审查。",
        "source_code": "INT-3",
    }


def test_returns_unique_scoped_rows_and_records_only_returned_ids() -> None:
    seen: dict = {}

    def loader(pg, auth, params):
        seen.update({"pg": pg, "auth": auth, "params": params})
        return [_row("C-1"), _row("C-1"), _row("C-2")]

    registry = RunRegistry()
    out = list_internal_obligations.call(
        AUTH,
        {
            "organizations": [],
            "biz_domains": ["合同管理"],
            "chapters": ["第一章"],
            "effective_from": "2024-01-01",
            "effective_to": "2026-12-31",
            "limit": 1,
        },
        {"pg": object(), "registry": registry, "load_internal_obligations": loader},
    )

    assert [row["chunk_id"] for row in out["items"]] == ["C-1"]
    assert out == {"items": [out["items"][0]], "total": 2, "truncated": True}
    assert out["items"][0]["deontic_type"] == "obligation"
    assert registry.allowed("run-1") == {"C-1"}
    assert seen["auth"] is AUTH
    assert seen["params"]["effective_from"] == date(2024, 1, 1)


def test_non_internal_scope_returns_empty_without_touching_database() -> None:
    out = list_internal_obligations.call(
        AuthScope(perm_tags=[], corpus_types=["external"], run_id="run-x"),
        {"limit": 10},
        {
            "pg": object(),
            "registry": RunRegistry(),
            "load_internal_obligations": lambda *_: pytest.fail("loader must not run"),
        },
    )
    assert out == {"items": [], "total": 0, "truncated": False}


@pytest.mark.parametrize(
    "arguments,message",
    [
        ({"organizations": ["总部"]}, "organizations"),
        ({"biz_domains": "合同"}, "biz_domains"),
        ({"chapters": [""]}, "chapters"),
        ({"effective_from": "2024/01/01"}, "effective_from"),
        ({"effective_from": "2026-01-01", "effective_to": "2024-01-01"}, "date range"),
        ({"limit": 0}, "limit"),
        ({"limit": 501}, "limit"),
    ],
)
def test_rejects_invalid_or_unsupported_scope(arguments: dict, message: str) -> None:
    with pytest.raises(ScopeError, match=message):
        list_internal_obligations.call(
            AUTH,
            arguments,
            {"pg": object(), "registry": RunRegistry(), "load_internal_obligations": lambda *_: []},
        )


def test_tool_schema_does_not_expose_authorization_fields() -> None:
    props = list_internal_obligations.TOOL.input_schema["properties"]
    assert "perm_tags" not in props
    assert "corpus_types" not in props
    assert "run_id" not in props
    assert list_internal_obligations.TOOL.name == "list_internal_obligations"


def test_m1_does_not_require_vector_index_activation() -> None:
    """M1 is a PG obligation listing path; parsed/enriched chunks need no Milvus activation."""
    import inspect

    source = inspect.getsource(list_internal_obligations._load_internal_obligations)
    assert "Chunk.chunk_status" not in source
