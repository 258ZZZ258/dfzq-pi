"""T10 桥接点亮集成测(价值验收,模型门:PG+Milvus+本地 BGE-M3,任一不可达 skip)。

CP-007 桥接双通道建成以来一直空转(cited_regulations 默认空);本套件验证 preseg 案例
结构化直装后**首次有数据命中**:
1. 分区归属:preseg 虚拟案例落 P-CASE 分区,retrieve_cases 语义可中;
2. 附挂反查:外规条款 norm_ref → bridge.cases_for_clauses 精确命中案例;
3. 判定型桥接:r5.resolve_cited_clauses 由案例反查到 effective 外规 chunk(桥接优先合并的输入);
4. B4 容错:零页码块(D2)全链不报错。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from sqlalchemy import delete, select, text

from common.pg_models import (
    Case,
    Chunk,
    Document,
    DocVersion,
    ImportBatch,
    PipelineEvent,
    ReviewQueue,
)
from pipeline.config import load_config
from pipeline.index.embedding_client import EmbeddingClient
from pipeline.index.milvus_io import MilvusIO
from pipeline.index.object_store import ObjectStore
from pipeline.index.pg_io import PgIO
from pipeline.stage_base import StageContext
from pipeline.stages import s1_parse, s3_structure, s4_meta, s5_embed_index
from pipeline.stages.s0_register import register_preseg_batch

FIXTURES = Path(__file__).parents[2] / "pipeline" / "tests" / "fixtures" / "preseg_batch"
BID = "preseg-t10-bridge"


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    if not os.environ.get("PIPELINE_EMBEDDING_MODEL"):
        pytest.skip("未设 PIPELINE_EMBEDDING_MODEL;桥接模型门跳过")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    cfg = load_config()
    pg = PgIO.from_config(cfg)
    try:
        with pg.session() as s:
            s.execute(text("select 1"))
    except Exception:
        pytest.skip("PG 不可达")
    mio = MilvusIO(cfg)
    try:
        mio.connect()
        mio.create_collection()
    except Exception:
        pytest.skip("Milvus 不可达")
    emb = EmbeddingClient.from_config(cfg)
    try:
        emb.embed(["探测"])
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"BGE-M3 加载失败: {e}")
    store = ObjectStore(tmp_path_factory.mktemp("obj"))
    ctx = StageContext(config=cfg, object_store=store, db=pg, embedding=emb, milvus=mio)
    yield pg, mio, ctx
    mio.disconnect()


@pytest.fixture(scope="module")
def ingested(stack):
    """fixtures 批次全链入库:外规 ext-001 与案例 KB-CASE-0001 均到 INDEXED(冷备重投影)。"""
    pg, mio, ctx = stack
    r = register_preseg_batch(ctx, BID, FIXTURES, FIXTURES / "manifest.xlsx")
    assert r.accepted
    ext = next(o.doc_version_id for o in r.outcomes if o.filename == "ext-001")
    case = next(
        o.doc_version_id for o in r.outcomes if o.filename.endswith("招揽客户案")
    )
    # 外规:s3(preseg 分支,免 IR)→ s5;案例:s1(合成 IR)→ s3(记录直建)→ s4(直装)→ s5
    s3_structure.run(ctx, ext)
    s5_embed_index.embed(ctx, ext)
    s5_embed_index.index(ctx, ext)
    s1_parse.start(ctx, case)
    s1_parse.run(ctx, case)
    s3_structure.run(ctx, case)
    s4_meta.run(ctx, case)
    s5_embed_index.embed(ctx, case)
    s5_embed_index.index(ctx, case)

    yield pg, mio, ctx, ext, case

    for dvid in (ext, case):
        try:
            mio.delete(dvid)
        except Exception:  # noqa: BLE001
            pass
    with pg.session() as s:
        dvs = list(s.scalars(select(DocVersion).where(DocVersion.batch_id == BID)))
        dvids = [d.doc_version_id for d in dvs]
        lids = {d.logical_id for d in dvs}
        if dvids:
            s.execute(delete(Case).where(Case.doc_version_id.in_(dvids)))
            s.execute(delete(Chunk).where(Chunk.doc_version_id.in_(dvids)))
            s.execute(delete(ReviewQueue).where(ReviewQueue.doc_version_id.in_(dvids)))
            s.execute(delete(PipelineEvent).where(PipelineEvent.doc_version_id.in_(dvids)))
            s.execute(delete(DocVersion).where(DocVersion.doc_version_id.in_(dvids)))
        if lids:
            s.execute(delete(Document).where(Document.logical_id.in_(lids)))
        s.execute(delete(ImportBatch).where(ImportBatch.batch_id == BID))


def test_partition_ownership_and_semantic_hit(ingested):
    """preseg 虚拟案例归 P-CASE 分区(口径钉子),口语问句语义可中(桥梁前提)。"""
    from query.config import load_query_config
    from query.retrieve.hybrid import Retriever

    pg, mio, ctx, ext, case = ingested
    assert mio.count(ext) > 0 and mio.count(case) > 0  # 投影就位
    r = Retriever(ctx.embedding, mio, load_query_config())
    hits = r.retrieve_cases("微信发二维码招揽开户违规吗")
    assert any(c.doc_version_id == case for c in hits)  # 案例分区语义命中
    assert all(c.doc_version_id != ext for c in hits)  # 外规不混入案例分区


def test_bridge_reverse_lookup_hits(ingested):
    """附挂通道:外规条款 norm_ref → 精确反查命中案例(空转通道首次有数据)。"""
    from query.case.bridge import cases_for_clauses, norm_ref

    pg, mio, ctx, ext, case = ingested
    key = norm_ref("证监会令第300号", "1/21")
    assert cases_for_clauses(pg, [key]) == [case]
    assert cases_for_clauses(pg, [norm_ref("证监会令第300号", "1/99")]) == []  # 不误中


def test_r5_bridge_resolves_case_to_ext_chunk(ingested):
    """判定型桥接入口:案例 → cited_regulations → effective 外规条款 chunk。"""
    from query.judge.r5_judgment import resolve_cited_clauses

    pg, mio, ctx, ext, case = ingested
    ids = resolve_cited_clauses(pg, [case])
    assert len(ids) == 1
    with pg.session() as s:
        chunk = s.get(Chunk, ids[0])
        assert chunk.doc_version_id == ext
        assert chunk.clause_path_norm == "1/21"
        assert "二维码" in chunk.text  # 拿到的是被违反条款原文


def test_zero_page_citation_tolerated(ingested):
    """B4/D2:零页码块全链无异常;PG 三级引用字段可空。"""
    pg, mio, ctx, ext, case = ingested
    with pg.session() as s:
        chunks = s.scalars(select(Chunk).where(Chunk.doc_version_id.in_([ext, case]))).all()
        assert chunks and all(c.page_start is None and c.page_end is None for c in chunks)
