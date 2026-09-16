from __future__ import annotations

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import resolve_source_law

AUTH = AuthScope(perm_tags=[], corpus_types=["internal"], run_id="run-1")


def _deps(loader, allowed=("C-1", "C-2")) -> dict:
    registry = RunRegistry()
    registry.record("run-1", allowed)
    return {"pg": object(), "registry": registry, "load_source_laws": loader}


def test_returns_real_mapping_and_rejects_ids_outside_current_run() -> None:
    seen: list[str] = []

    def loader(pg, chunk_ids):
        seen.extend(chunk_ids)
        return {
            "existing": set(chunk_ids),
            "source_laws": {
                "C-1": [
                    {
                        "doc_no": "外规〔2025〕1号",
                        "doc_title": "关联交易规则",
                        "clause_path": "第五条",
                        "source_code": "EXT-5",
                    }
                ]
            },
        }

    out = resolve_source_law.call(
        AUTH,
        {"chunk_ids": ["C-1", "C-9"]},
        _deps(loader),
    )

    assert seen == ["C-1"]
    assert out["items"][0]["source_laws"][0]["clause_path"] == "第五条"
    assert out["rejected"] == ["C-9"]
    assert out["unresolved"] == []


def test_explicit_uploaded_target_enables_auditable_document_level_fallback() -> None:
    out = resolve_source_law.call(
        AUTH,
        {
            "chunk_ids": ["C-1", "C-2"],
            "target_document": {"title": "关联交易管理办法", "doc_no": "外规〔2026〕8号"},
        },
        _deps(
            lambda pg, chunk_ids: {
                "existing": {"C-1"},
                "source_laws": {},
            }
        ),
    )

    assert out["items"] == [
        {
            "chunk_id": "C-1",
            "source_laws": [
                {
                    "doc_no": "外规〔2026〕8号",
                    "doc_title": "关联交易管理办法",
                    "clause_path": None,
                    "source_code": None,
                }
            ],
        }
    ]
    assert out["unresolved"] == ["C-2"]
    assert out["fallback"] == ["C-1"]


def test_without_target_missing_mapping_stays_unresolved() -> None:
    out = resolve_source_law.call(
        AUTH,
        {"chunk_ids": ["C-1"]},
        _deps(lambda pg, chunk_ids: {"existing": {"C-1"}, "source_laws": {}}),
    )
    assert out == {"items": [], "rejected": [], "unresolved": ["C-1"], "fallback": []}


def test_empty_m1_result_is_a_valid_empty_resolution() -> None:
    out = resolve_source_law.call(
        AUTH,
        {"chunk_ids": []},
        _deps(lambda *_: pytest.fail("loader must not run")),
    )
    assert out == {"items": [], "rejected": [], "unresolved": [], "fallback": []}


@pytest.mark.parametrize(
    "arguments,message",
    [
        ({"chunk_ids": [""]}, "chunk_ids"),
        ({"chunk_ids": ["C-1"] * 501}, "chunk_ids"),
        ({"chunk_ids": ["C-1"], "target_document": {}}, "target_document.title"),
        ({"chunk_ids": ["C-1"], "target_document": {"title": "x", "doc_no": 1}}, "doc_no"),
    ],
)
def test_rejects_invalid_arguments(arguments: dict, message: str) -> None:
    with pytest.raises(ScopeError, match=message):
        resolve_source_law.call(AUTH, arguments, _deps(lambda *_: {}))


def test_tool_schema_does_not_expose_authorization_fields() -> None:
    props = resolve_source_law.TOOL.input_schema["properties"]
    assert "perm_tags" not in props
    assert "corpus_types" not in props
    assert "run_id" not in props
    assert resolve_source_law.TOOL.name == "resolve_source_law"
