"""T11 端到端(模型门:PG+Milvus+BGE-M3):orchestrator 驱动全批次 REGISTERED→INDEXED、
finalize T4 豁免留痕(D2)、幂等重跑零漂移、reconcile 对 preseg 数据行为正确、冷备在位
(rebuild 前提;全局 rebuild 留合并门人工跑,不在共享栈上全量触发)。"""

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
    RemediationRecord,
    ReviewQueue,
)
from pipeline import cli
from pipeline.config import load_config
from pipeline.index.embedding_client import EmbeddingClient
from pipeline.index.milvus_io import MilvusIO
from pipeline.index.object_store import ObjectStore
from pipeline.index.pg_io import PgIO
from pipeline.stage_base import StageContext
from pipeline.stages.s0_register import register_preseg_batch

FIXTURES = Path(__file__).parent / "fixtures" / "preseg_batch"
BID = "preseg-t11-e2e"


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    if not os.environ.get("PIPELINE_EMBEDDING_MODEL"):
        pytest.skip("未设 PIPELINE_EMBEDDING_MODEL;e2e 模型门跳过")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    cfg = load_config()
    # 无冲突自动放行(B 模式口径),e2e 验证管线机制而非人工闸
    cfg = cfg.model_copy(
        update={"toggles": cfg.toggles.model_copy(update={"auto_confirm_meta_no_conflict": True})}
    )
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
    ctx = StageContext(
        config=cfg,
        object_store=ObjectStore(tmp_path_factory.mktemp("obj")),
        db=pg,
        embedding=emb,
        milvus=mio,
    )
    yield pg, mio, ctx
    mio.disconnect()


@pytest.fixture(scope="module")
def driven(stack):
    """注册 + orchestrator 驱动整批到停态;yield 后全量清理(Milvus+PG,FK 序)。"""
    pg, mio, ctx = stack
    report = register_preseg_batch(ctx, BID, FIXTURES, FIXTURES / "manifest.xlsx")
    assert report.accepted
    cli._drive_batch(pg, ctx, BID)
    with pg.session() as s:
        dvs = list(s.scalars(select(DocVersion).where(DocVersion.batch_id == BID)))
    yield pg, mio, ctx, report, {dv.source_filename or dv.title: dv.doc_version_id for dv in dvs}
    with pg.session() as s:
        dvids = [dv.doc_version_id for dv in dvs]
        lids = {dv.logical_id for dv in dvs}
        for dvid in dvids:
            try:
                mio.delete(dvid)
            except Exception:  # noqa: BLE001
                pass
        if dvids:
            from common.pg_models import ClauseReference, ClauseTag

            chunk_ids = list(
                s.scalars(select(Chunk.chunk_id).where(Chunk.doc_version_id.in_(dvids)))
            )
            if chunk_ids:  # E1 义务打标在 _drive_batch 中对 preseg chunks 照常跑(良性)
                s.execute(delete(ClauseTag).where(ClauseTag.chunk_id.in_(chunk_ids)))
                s.execute(
                    delete(ClauseReference).where(ClauseReference.chunk_id.in_(chunk_ids))
                )
            s.execute(delete(Case).where(Case.doc_version_id.in_(dvids)))
            s.execute(delete(Chunk).where(Chunk.doc_version_id.in_(dvids)))
            s.execute(delete(RemediationRecord).where(RemediationRecord.doc_version_id.in_(dvids)))
            s.execute(delete(ReviewQueue).where(ReviewQueue.doc_version_id.in_(dvids)))
            s.execute(delete(PipelineEvent).where(PipelineEvent.doc_version_id.in_(dvids)))
            s.execute(delete(DocVersion).where(DocVersion.doc_version_id.in_(dvids)))
        if lids:
            s.execute(delete(Document).where(Document.logical_id.in_(lids)))
        s.execute(delete(ImportBatch).where(ImportBatch.batch_id == BID))


def test_whole_batch_reaches_indexed(driven):
    pg, mio, ctx, report, dvids = driven
    with pg.session() as s:
        dvs = list(s.scalars(select(DocVersion).where(DocVersion.batch_id == BID)))
    assert len(dvs) == 4  # 2 文档 + 2 案例虚拟文档
    assert {dv.pipeline_status for dv in dvs} == {"INDEXED"}
    for dv in dvs:
        assert mio.count(dv.doc_version_id) > 0  # 投影全就位
    # 结构化直装随管线自动发生(非手工调):案例 cited_regulations 已点亮
    case_dvid = next(v for k, v in dvids.items() if k and "招揽客户案" in str(k))
    case = ctx.db.get_case(case_dvid)
    assert case is not None and case.cited_regulations and case.persons


def test_finalize_t4_exempt_t2_ran(driven):
    """D2:preseg 件 finalize 留痕 = T4 显式豁免(非静默、非失败)+ T2 冒烟照跑。"""
    pg, mio, ctx, report, dvids = driven
    with pg.session() as s:
        events = list(
            s.scalars(
                select(PipelineEvent).where(
                    PipelineEvent.doc_version_id.in_(list(dvids.values()))
                )
            )
        )
    verifies = [e.detail["verify"] for e in events if e.detail and "verify" in e.detail]
    assert verifies, "finalize 未留 verify 痕"
    for v in verifies:
        assert v.get("t4_skipped") and "D2" in v["t4_skipped"]  # 显式豁免
        assert v.get("t4_pass") is None  # 不计失败
        assert "t2_hit" in v  # T2 冒烟跑过(命中与否据实)


def test_idempotent_rerun_zero_drift(driven):
    pg, mio, ctx, report, dvids = driven
    with pg.session() as s:
        n_dv = len(s.scalars(select(DocVersion).where(DocVersion.batch_id == BID)).all())
        n_chunk = len(
            s.scalars(
                select(Chunk).where(Chunk.doc_version_id.in_(list(dvids.values())))
            ).all()
        )
    m_counts = {d: ctx.milvus.count(d) for d in dvids.values()}

    r2 = register_preseg_batch(ctx, BID, FIXTURES, FIXTURES / "manifest.xlsx")
    assert {o.status for o in r2.outcomes} == {"DUPLICATE"}
    cli._drive_batch(pg, ctx, BID)  # 再驱动也无事发生

    with pg.session() as s:
        assert len(s.scalars(select(DocVersion).where(DocVersion.batch_id == BID)).all()) == n_dv
        assert (
            len(
                s.scalars(
                    select(Chunk).where(Chunk.doc_version_id.in_(list(dvids.values())))
                ).all()
            )
            == n_chunk
        )
    assert {d: ctx.milvus.count(d) for d in dvids.values()} == m_counts


def test_reconcile_scoped_consistent(driven):
    from eval.reconcile import run_reconcile

    pg, mio, ctx, report, dvids = driven
    res = run_reconcile(ctx, list(dvids.values()))
    assert res.consistent
    assert all(r["pg"] == r["milvus"] for r in res.per_doc)  # 源库↔PG 之后的 PG↔Milvus 级对账


def test_cold_backup_present_for_rebuild(driven):
    """rebuild 前提:非父块冷备向量在位(全局 rebuild 留合并门,不在共享栈全量触发)。"""
    pg, mio, ctx, report, dvids = driven
    with pg.session() as s:
        chunks = s.scalars(
            select(Chunk).where(
                Chunk.doc_version_id.in_(list(dvids.values())), Chunk.is_parent.is_(False)
            )
        ).all()
    assert chunks and all(c.dense_vec_cold is not None for c in chunks)


def test_preseg_case_reprocess_via_public_entry(driven):
    """PRESEG **虚拟案例**可经公开 reprocess 入口重处理(``cli.reprocess_to_indexed``:重置 REGISTERED
    → 复用**同 dvid** 重跑 S1→S3→S4→S5 → 重回 INDEXED、Milvus 投影重建),**非重灌**(同内容重灌经
    S0 幂等 = DUPLICATE no-op,见 test_preseg_cases_ingest)。**本测只证公开入口对虚拟案例可跑通**;
    genuine 的 fuzzy→exact 桥接恢复语义由 PG-only 测
    ``test_reprocess_rerun_recovers_fuzzy_to_exact_idempotent`` 覆盖(此处法规已建块、案例本就 exact,
    不再重复断言恢复)。**放本文件最后**,避免扰动共享 driven(reprocess 幂等回 INDEXED,不漂移)。"""
    pg, mio, ctx, report, dvids = driven
    case_dvid = next(v for k, v in dvids.items() if k and "招揽客户案" in str(k))
    final = cli.reprocess_to_indexed(pg, ctx, case_dvid, operator="test")
    assert final == "INDEXED"  # 虚拟案例走通完整重处理链
    case = ctx.db.get_case(case_dvid)
    assert case is not None and case.cited_regulations  # 案例行 + 引用留存
    assert mio.count(case_dvid) > 0  # 投影重建就位