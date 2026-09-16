"""T7(SPEC-API §8.3):条款回查端点。

单元:TestClient + fake svc.clause_detail(免栈)——四级锚点+全文+父块、404。
集成:svc.clause_detail 连真栈(indexed_stack)验 PG 权威回查;离线 skip。
"""

from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from query.api.app import create_app

_PREFIX = "/api/query/v1"


def _client(detail):
    svc = SimpleNamespace(clause_detail=lambda cid: detail if cid == "c1" else None)
    return TestClient(create_app(service=svc))


def test_clause_detail_returns_anchor_text_parent():
    detail = {
        "clause_id": "c1", "doc_title": "《客户适当性管理实施细则》", "doc_no": "NEEQ-QF-2020-034",
        "clause_path": "第三章/第三条 适还比例界定", "page_start": 7, "page_end": 7,
        "version": "2021-02-01", "status": "effective",
        "text": "第三条 适还比例界定与银保监法说明……",
        "parent_text": "第三章 适当性识别(节级父块全文)……",
    }
    r = _client(detail).get(f"{_PREFIX}/clauses/c1")
    assert r.status_code == 200
    b = r.json()
    assert b["clause_id"] == "c1" and b["status"] == "effective"
    assert b["text"].startswith("第三条") and b["parent_text"].startswith("第三章")


def test_clause_not_found_404():
    assert _client({}).get(f"{_PREFIX}/clauses/nope").status_code == 404


def test_dm_clause_detail_falls_back_to_ordered_text_details(monkeypatch):
    """真实达梦主表正文为空时，详情 API 仍必须返回完整可读条文。"""
    import sqlalchemy

    from query.api.service import QueryService

    class _Rows:
        def __init__(self, rows):
            self._rows = rows

        def mappings(self):
            return self

        def first(self):
            return self._rows[0] if self._rows else None

        def all(self):
            return self._rows

    class _Connection:
        def __init__(self):
            self.sql = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement, params):
            self.sql.append((str(statement), params))
            if "ZNFG_IAM_LAW_CONTENT_DETAIL" not in str(statement):
                return _Rows([{
                    "source_doc_id": "LAW-1", "doc_title": "测试法规", "doc_number": None,
                    "issuer": None, "status_code": "inuse", "effective_date": None,
                    "source_code": "CONTENT-1", "clause_title": "第一条", "clause_path": None,
                    "full_text": "",
                }])
            return _Rows([
                {"content_order": 2, "content": "后半段。"},
                {"content_order": 1, "content": "前半段"},
            ])

    class _Engine:
        def __init__(self):
            self.connection = _Connection()

        def connect(self):
            return self.connection

    engine = _Engine()
    monkeypatch.setenv("PRESEG_SOURCE_DSN", "postgresql://mock")
    monkeypatch.setattr(sqlalchemy, "create_engine", lambda *_args, **_kwargs: engine)
    svc = QueryService(agent=None, pg=None, store=None, retriever=None, qcfg=None)

    detail = svc.dm_clause_detail("CONTENT-1", "LAW-1")

    assert detail["full_text"] == "前半段\n后半段。"
    assert detail["text"] == detail["full_text"]
    assert len(engine.connection.sql) == 2
    assert "CONTENT_TYPE = 0" in engine.connection.sql[1][0]
    assert engine.connection.sql[1][1] == {"source_code": "CONTENT-1", "source_doc_id": "LAW-1"}


# ── 集成(真栈;离线 skip)────────────────────────────────────────────────────
def test_clause_detail_integration(indexed_stack):
    from sqlalchemy import select

    from common.pg_models import Chunk
    from query.api.service import QueryService

    pg = indexed_stack.pg
    svc = QueryService(agent=None, pg=pg, store=None, retriever=None, qcfg=None)
    with pg.session() as s:
        cid = s.scalars(select(Chunk.chunk_id)).first()
    detail = svc.clause_detail(cid)
    assert detail["clause_id"] == cid and detail["text"]     # 全文来自 PG 权威
    assert detail["doc_title"] and detail["status"]          # 四级锚点
    assert svc.clause_detail("NONEXISTENT_CLAUSE") is None
