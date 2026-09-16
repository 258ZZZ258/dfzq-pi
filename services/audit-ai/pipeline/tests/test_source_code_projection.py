"""DM 回查键(source_code/source_doc_id)投影:schema/build_rows/upsert 携带(CP-010)。零栈。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from common.milvus_schema import audit_corpus_schema
from common.pg_models import DocVersion
from pipeline.config import load_config
from pipeline.index.corpus_rows import build_rows
from pipeline.index.milvus_io import CorpusRow, MilvusIO, _to_milvus_dict


def _row(**kw) -> CorpusRow:
    base = dict(
        chunk_id="c1", dense=[0.1], sparse={}, doc_id="D", doc_version_id="V", corpus_type="P-INT",
        sub_type="", status="effective", perm_tag=[], biz_domain=[], issuer_level=0, entity_type=[],
        chunk_type="clause", clause_path="第一条", page_start=0, effective_date=0, text="t",
        degraded=False,
    )
    base.update(kw)
    return CorpusRow(**base)


def test_schema_has_source_code_fields():
    names = {f.name for f in audit_corpus_schema().fields}
    assert "source_code" in names and "source_doc_id" in names


def test_to_milvus_dict_carries_source_code():
    d = _to_milvus_dict(_row(source_code="LC-CODE-1", source_doc_id="LB-CODE-1"))
    assert d["source_code"] == "LC-CODE-1"
    assert d["source_doc_id"] == "LB-CODE-1"


def test_corpus_row_source_code_defaults_empty():
    r = _row()  # 不传 → 默认空串(向后兼容既有构造)
    assert r.source_code == "" and r.source_doc_id == ""


class _FakeDb:
    def __init__(self, dv, doc):
        self._dv, self._doc = dv, doc

    def get(self, model, pk):
        return self._dv if model is DocVersion else self._doc


def _dv(**kw):
    base = dict(
        logical_id="LID", effective_date=None, perm_tag=None, biz_domains=None, biz_domain=None,
        sub_type=None, source_doc_id="LB-CODE-9",
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _chunk(**kw):
    base = dict(
        chunk_id="c1", source_code="LC-CODE-9", entity_type=None, chunk_type="clause",
        clause_path="第一条", page_start=1, text="正文", degraded=False, chunk_status="effective",
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_build_rows_populates_source_code_from_pg():
    rows = build_rows(_FakeDb(_dv(), SimpleNamespace(corpus_type="P-EXT")), "V",
                      [_chunk()], [([0.1], {})], "effective")
    assert rows[0].source_code == "LC-CODE-9"  # chunk.source_code 透传
    assert rows[0].source_doc_id == "LB-CODE-9"  # dv.source_doc_id 透传


def test_build_rows_source_code_empty_for_non_dm():
    # 非 DM 源(P-QA 自建):chunk.source_code / dv.source_doc_id 为 None → 空串
    rows = build_rows(_FakeDb(_dv(source_doc_id=None), SimpleNamespace(corpus_type="P-QA")), "V",
                      [_chunk(source_code=None, chunk_type="qa")], [([0.1], {})], "effective")
    assert rows[0].source_code == "" and rows[0].source_doc_id == ""


# ── 真栈:Milvus 真的存并从 hit 返回 source_code(PG-free 前提)──
@pytest.fixture
def _stack_mio():
    from pymilvus import utility

    cfg = load_config()
    cfg.milvus.collection = "audit_corpus_srccode_" + uuid.uuid4().hex[:8]
    mio = MilvusIO(cfg)
    try:
        mio.connect()
        utility.list_collections()  # 强制真实连接,不可达则 skip
    except Exception:
        pytest.skip("Milvus 不可达(demo up 未起)")
    mio.create_collection(drop_existing=True)
    yield mio
    if utility.has_collection(cfg.milvus.collection):
        utility.drop_collection(cfg.milvus.collection)
    mio.disconnect()


def test_milvus_projects_and_returns_source_code(_stack_mio):
    mio = _stack_mio
    mio.upsert([_row(dense=[0.1] * 1024, sparse={"1": 0.5},
                     source_code="LC-9", source_doc_id="LB-9")])
    mio.flush()
    res = mio.search([0.1] * 1024, {"1": 0.5}, topk=5)
    hit = next(h for h in res.hits if h["chunk_id"] == "c1")
    assert hit["source_code"] == "LC-9"  # Milvus 存并从 hit 返回(候选据此吐 DM 键,零 PG 回查)
    assert hit["source_doc_id"] == "LB-9"
