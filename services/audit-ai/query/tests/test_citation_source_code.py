"""citation 携带 DM 回查键:Candidate/_to_candidate/Citation.to_dict/边界 _source_map。零栈。"""

from __future__ import annotations

from types import SimpleNamespace

from query.api.routes_boundary import _source_map
from query.contract import Citation
from query.retrieve.hybrid import _to_candidate


def test_to_candidate_carries_source_code():
    c = _to_candidate({"chunk_id": "c1", "score": 0.5, "source_code": "LC-1",
                       "source_doc_id": "LB-1"}, "hybrid")
    assert c.source_code == "LC-1" and c.source_doc_id == "LB-1"


def test_to_candidate_source_code_absent_none():
    c = _to_candidate({"chunk_id": "c1", "score": 0.5}, "hybrid")  # 存量索引 hit 无该字段
    assert c.source_code is None and c.source_doc_id is None


def test_citation_to_dict_has_source_code():
    d = Citation(clause_id="c1", source_code="LC-1", source_doc_id="LB-1").to_dict()
    assert d["source_code"] == "LC-1" and d["source_doc_id"] == "LB-1"


def test_citation_source_code_defaults_none_backward_compat():
    d = Citation(clause_id="c1").to_dict()  # 不传 → None(前端契约向后兼容,不减不改既有键)
    assert d["source_code"] is None and d["source_doc_id"] is None
    assert d["clause_id"] == "c1"  # 既有键仍在


def test_source_map_from_candidates_normalizes_empty_to_none():
    cands = [
        SimpleNamespace(chunk_id="c1", source_code="LC-1", source_doc_id="LB-1"),
        SimpleNamespace(chunk_id="c2", source_code="", source_doc_id=""),  # 非 DM/弃锚
    ]
    m = _source_map(cands)
    assert m["c1"] == {"source_code": "LC-1", "source_doc_id": "LB-1"}
    assert m["c2"] == {"source_code": None, "source_doc_id": None}  # 空串归一 None
