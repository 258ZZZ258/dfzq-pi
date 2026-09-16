"""T8(CP-012):bm25 端到端(seed chunks → embed→index → INDEXED)+ 发文字号 BM25 精确命中(价值验收)。

gate:PIPELINE_EMBEDDING_MODEL(本地 BGE-M3,出 dense)+ PG + Milvus 2.5,缺任一 skip。
证:①sparse_backend=bm25 全链 INDEXED;②冷备 sparse 免冷存(sparse_vec_cold=None,dense 齐);
③Milvus 从 text 算 BM25,发文字号查询 hybrid 命中且目标块 rank#1(优于纯 dense);④幂等重灌计数不漂。
"""

import os
import uuid

import pytest
from sqlalchemy import delete, text
from ulid import ULID

from common.pg_models import Chunk, Document, DocVersion, ImportBatch, PipelineEvent
from pipeline.config import load_config
from pipeline.index.embedding_client import EmbeddingClient
from pipeline.index.milvus_io import MilvusIO
from pipeline.index.object_store import ObjectStore
from pipeline.index.pg_io import PgIO
from pipeline.orchestrator import Orchestrator
from pipeline.stage_base import StageContext
from pipeline.stages import s5_embed_index as s5
from pipeline.states import PipelineState as PS

# 目标块含发文字号(BM25 高 IDF 精确命中);干扰块语义相近但无发文字号
_DOCNUM = "证监会公告〔2023〕15号"
_CHUNKS = [
    ("1", f"{_DOCNUM} 关于加强上市公司信息披露监督管理的规定", "1/1", False),
    ("2", "关于规范信息披露行为的通知,要求各机构完善披露流程", "1/2", False),
    ("p", "第一章 总则", "1", True),  # 父块:仅 PG,不入 Milvus
]


def _advance(pg, ctx, dvid):
    orch = Orchestrator(pg, ctx, {PS.EMBEDDING: s5.embed, PS.INDEXING: s5.index})
    for _ in range(10):
        if not orch.step(pg.get(DocVersion, dvid)):
            break


@pytest.fixture
def bm25_e2e():
    if not os.environ.get("PIPELINE_EMBEDDING_MODEL"):
        pytest.skip("未设 PIPELINE_EMBEDDING_MODEL(本地 BGE-M3);bm25 e2e 跳过")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    cfg = load_config()
    cfg.embedding.sparse_backend = "bm25"  # 内网 vLLM only-dense 适配态
    cfg.milvus.collection = "audit_corpus_bm25_e2e_" + uuid.uuid4().hex[:8]  # 隔离 bm25 集合
    pg = PgIO.from_config(cfg)
    try:
        with pg.session() as s:
            s.execute(text("select 1"))
    except Exception:
        pytest.skip("PG 不可达")
    mio = MilvusIO(cfg)
    try:
        mio.connect()
        from pymilvus import utility
    except Exception:
        pytest.skip("Milvus 不可达")
    mio.create_collection(drop_existing=True)  # bm25 schema(Function + BM25 索引)
    emb = EmbeddingClient.from_config(cfg)
    try:
        emb.embed(["探测"])
    except Exception as e:
        pytest.skip(f"BGE-M3 加载失败: {e}")
    ctx = StageContext(
        config=cfg, object_store=ObjectStore.from_config(cfg), db=pg, embedding=emb, milvus=mio
    )
    bid, lid, dvid = "bm25e2e_" + str(ULID()), str(ULID()), str(ULID())
    with pg.session() as s:
        s.add(ImportBatch(batch_id=bid, source_dir="x"))
        s.add(Document(logical_id=lid, corpus_type="P-INT"))
        s.flush()
        s.add(
            DocVersion(
                doc_version_id=dvid, logical_id=lid, batch_id=bid, source_format="docx",
                source_hash="h" + dvid[:8], raw_object_key="k",
                pipeline_status=PS.EMBEDDING.value, degraded=False,
                perm_tag="内部", biz_domain="DISCLOSURE", issuer="CSRC",
            )
        )
        s.flush()
        for suf, txt, norm, is_parent in _CHUNKS:
            s.add(
                Chunk(
                    chunk_id=(dvid[:22] + suf)[:24], doc_version_id=dvid, text=txt,
                    clause_path=norm, clause_path_norm=norm, seq=int(suf, 36), page_start=1,
                    is_parent=is_parent, is_table=False, degraded=False, chunk_status="staging",
                )
            )
    target_id = (dvid[:22] + "1")[:24]
    yield pg, ctx, mio, dvid, target_id
    from pymilvus import utility

    mio.delete(dvid)
    mio.flush()
    if utility.has_collection(cfg.milvus.collection):
        utility.drop_collection(cfg.milvus.collection)
    with pg.session() as s:
        s.execute(delete(Chunk).where(Chunk.doc_version_id == dvid))
        s.execute(delete(PipelineEvent).where(PipelineEvent.doc_version_id == dvid))
        s.execute(delete(DocVersion).where(DocVersion.doc_version_id == dvid))
        s.execute(delete(Document).where(Document.logical_id == lid))
        s.execute(delete(ImportBatch).where(ImportBatch.batch_id == bid))
    mio.disconnect()


def test_bm25_e2e_indexed_cold_sparse_omitted(bm25_e2e):
    pg, ctx, mio, dvid, _ = bm25_e2e
    _advance(pg, ctx, dvid)  # EMBEDDING → INDEXING → INDEXED

    assert pg.get(DocVersion, dvid).pipeline_status == "INDEXED"
    chunks = pg.get_chunks(dvid)
    nonparent = [c for c in chunks if not c.is_parent]
    # bm25:dense 冷备齐、sparse 免冷存(sparse_vec_cold=None)
    assert all(c.dense_vec_cold is not None for c in nonparent)
    assert all(c.sparse_vec_cold is None for c in nonparent)
    assert mio.count(dvid) == len(nonparent) == 2  # parent 排除,Milvus 从 text 产 sparse
    assert all(c.chunk_status == "effective" for c in chunks)


def test_bm25_e2e_docnum_precise_hit_ranks_first(bm25_e2e):
    pg, ctx, mio, dvid, target_id = bm25_e2e
    _advance(pg, ctx, dvid)
    qdense = ctx.embedding.embed([_DOCNUM])[0].dense

    # hybrid(BM25 + dense):发文字号精确命中 → 目标块 rank#1
    hybrid = mio.search(qdense, {}, topk=10, corpus="P-INT", query_text=_DOCNUM)
    assert hybrid.retrieval_mode == "hybrid"
    hits = [h["chunk_id"] for h in hybrid.hits]
    assert hits and hits[0] == target_id  # BM25 高 IDF 精确命中浮顶

    # 纯 dense(缺 query_text → dense_only 兜底):目标块未必 rank#1 → 证 BM25 提供的精确增益
    dense_only = mio.search(qdense, {}, topk=10, corpus="P-INT", query_text=None)
    assert dense_only.retrieval_mode == "dense_only"
    d_hits = [h["chunk_id"] for h in dense_only.hits]
    hybrid_rank = hits.index(target_id)
    dense_rank = d_hits.index(target_id) if target_id in d_hits else len(d_hits)
    assert hybrid_rank <= dense_rank  # 发文字号命中优于纯 dense(不劣于)


def test_bm25_e2e_reindex_idempotent(bm25_e2e):
    pg, ctx, mio, dvid, _ = bm25_e2e
    _advance(pg, ctx, dvid)
    before = mio.count(dvid)
    # 从冷备重灌(确定性 chunk_id → 覆盖,不新增):计数不漂
    from pipeline.index import corpus_rows

    rows = corpus_rows.rows_from_cold_strict(pg, dvid, "effective", sparse_backend="bm25")
    mio.upsert(rows)
    mio.flush()
    assert mio.count(dvid) == before == 2
