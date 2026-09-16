"""T7 adapter 纯函数测试(零栈)+ s3 分支集成(真 PG)。

覆盖:chunk_id 幂等/同 norm 多块 seq 递增/章节上下文继承/伪路径标记/超预算二次切分
oversize/表格透传/entity_type 文档级继承(D7)/零页码(D2)/搬运保真(文本不加工)。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from common.chunk_id import compute_chunk_id
from pipeline.config import load_config
from pipeline.preseg.adapter import build_preseg_specs
from pipeline.preseg.reader import PresegBlock

CFG = load_config().chunk


def _b(seq, label, text, table=False):
    return PresegBlock(block_seq=seq, text=text, clause_label=label, is_table=table)


class TestAdapterPure:
    def test_basic_article_chunks(self):
        blocks = [
            _b(0, "第一条", "为规范……制定本办法。"),
            _b(1, "第二十一条", "不得通过二维码招揽。"),
        ]
        specs = build_preseg_specs("dv1", blocks, CFG)
        assert [s.clause_path_norm for s in specs] == ["1", "21"]
        assert all(s.seq == 0 for s in specs)
        assert specs[0].chunk_id == compute_chunk_id("dv1", "1", 0)  # B1 公式不变
        assert specs[1].text == "不得通过二维码招揽。"  # 搬运保真:不加前缀不改写

    def test_chunk_id_deterministic(self):
        blocks = [_b(0, "第一条", "内容")]
        a = build_preseg_specs("dv1", blocks, CFG)
        b = build_preseg_specs("dv1", blocks, CFG)
        assert a[0].chunk_id == b[0].chunk_id  # 幂等重跑同 id(覆盖安全)

    def test_same_norm_multi_block_seq_increments(self):
        blocks = [_b(1, "第五条", "正文一。"), _b(2, "第五条", "(续)正文二。")]
        specs = build_preseg_specs("dv1", blocks, CFG)
        assert [(s.clause_path_norm, s.seq) for s in specs] == [("5", 0), ("5", 1)]
        assert len({s.chunk_id for s in specs}) == 2  # 不撞 id

    def test_chapter_section_context_inheritance(self):
        blocks = [
            _b(0, "第三章", "监督管理"),
            _b(1, "第二十一条", "章下条。"),
            _b(2, "第一节", "一般规定"),
            _b(3, "第二十二条", "节下条。"),
            _b(4, "第四章", "罚则"),
            _b(5, "第三十条", "换章后条(节上下文应清空)。"),
        ]
        specs = build_preseg_specs("dv1", blocks, CFG)
        assert [s.clause_path_norm for s in specs] == ["3/21", "3/1/22", "4/30"]
        assert specs[0].breadcrumb == "第三章 > 第二十一条"
        assert len(specs) == 3  # 章/节标题块不成块

    def test_label_embedded_chapter_wins(self):
        specs = build_preseg_specs("dv1", [_b(0, "第十二章第一百零五条", "内容")], CFG)
        assert specs[0].clause_path_norm == "12/105"

    def test_underivable_falls_to_pseudo_path(self):
        blocks = [_b(4, "备注说明", "无法推导的块。"), _b(7, None, "无标识块。")]
        specs = build_preseg_specs("dv1", blocks, CFG)
        assert [s.clause_path_norm for s in specs] == ["preseg/4", "preseg/7"]
        assert all(s.chunk_type == "preseg_raw" for s in specs)

    def test_source_anchored_detail_without_article_label_is_a_clause(self):
        """DM 详情正文一行一块，即便无“第X条”标题也须参与内规覆盖核查。"""
        block = PresegBlock(
            block_seq=12,
            text="各单位应当加强员工投资行为管理，落实事前申报和事后登记要求。",
            source_code="LAW-CONTENT-9",
        )

        spec = build_preseg_specs("dv1", [block], CFG)[0]

        assert spec.clause_path_norm == "preseg/12"
        assert spec.chunk_type == "clause"
        assert spec.source_code == "LAW-CONTENT-9"

    def test_oversize_split_marks_hard_cut(self):
        long_no_boundary = "甲" * (CFG.target_token_max * 2 + 10)  # 无句末边界 → 字符硬切
        specs = build_preseg_specs("dv1", [_b(0, "第九条", long_no_boundary)], CFG)
        assert len(specs) >= 2
        assert all(s.clause_path_norm == "9" for s in specs)
        assert [s.seq for s in specs] == list(range(len(specs)))
        assert any(s.oversize for s in specs)

    def test_oversize_split_at_sentence_boundary(self):
        n = (CFG.target_token_max * 2) // 7 + 2  # 按配置动态超预算
        sent = "本条内容较长;" * n  # 有;边界 → 语义切,不标 oversize
        specs = build_preseg_specs("dv1", [_b(0, "第十条", sent)], CFG)
        assert len(specs) >= 2 and not any(s.oversize for s in specs)

    def test_table_passthrough(self):
        specs = build_preseg_specs("dv1", [_b(5, None, "|列|\n|---|\n|值|", table=True)], CFG)
        assert specs[0].is_table and specs[0].chunk_type == "table"

    def test_entity_type_doc_level_inheritance(self):
        ets = ["证券公司", "证券从业人员"]
        specs = build_preseg_specs("dv1", [_b(0, "第一条", "内容"), _b(4, "备注", "伪路径块")],
                                   CFG, entity_types=ets)
        assert all(s.entity_type == ets for s in specs)  # D7:含伪路径块全继承
        no_et = build_preseg_specs("dv1", [_b(0, "第一条", "内容")], CFG)
        assert no_et[0].entity_type is None

    def test_zero_page(self):
        specs = build_preseg_specs("dv1", [_b(0, "第一条", "内容")], CFG)
        assert specs[0].page_start is None and specs[0].page_end is None  # D2


class TestAdapterAuthoritative:
    """CP-010 内网对齐:源权威 clause_path_norm(PATH_CODE 算好)/ is_catalog / source_code。"""

    def test_authoritative_norm_wins_and_never_pseudo(self):
        # label 无法 derive("备注说明"),但源给了权威 norm → 用权威、且是真 clause 非伪路径
        b = PresegBlock(block_seq=4, text="正文。", clause_label="备注说明",
                        clause_path_norm="3/21")
        specs = build_preseg_specs("dv1", [b], CFG)
        assert specs[0].clause_path_norm == "3/21"
        assert specs[0].chunk_type == "clause"  # 有权威路径即真条款,绝不 preseg_raw
        assert specs[0].chunk_id == compute_chunk_id("dv1", "3/21", 0)  # B1 公式不变

    def test_is_catalog_block_not_chunked(self):
        # is_catalog(源 IS_CATALOG==1)权威:即便 label 非"第X章"形态(如"总则")也不成块
        blocks = [
            PresegBlock(block_seq=0, text="总则", clause_label="总则", is_catalog=True),
            PresegBlock(block_seq=1, text="正文。", clause_label="第一条",
                        clause_path_norm="1/1"),
        ]
        specs = build_preseg_specs("dv1", blocks, CFG)
        assert len(specs) == 1  # 目录块不出 chunk
        assert specs[0].clause_path_norm == "1/1"

    def test_source_code_passthrough(self):
        b = PresegBlock(block_seq=1, text="正文。", clause_label="第二十一条",
                        source_code="LC-EXT001-021")
        specs = build_preseg_specs("dv1", [b], CFG)
        assert specs[0].source_code == "LC-EXT001-021"  # 透传到 chunks.source_code(精确桥接锚)

    def test_no_source_code_is_none(self):
        specs = build_preseg_specs("dv1", [_b(0, "第一条", "内容")], CFG)
        assert specs[0].source_code is None  # 自建/无锚批次恒 None → 回落 fuzzy align


# ── s3 分支集成(真 PG)──────────────────────────────────────


@pytest.fixture
def env(tmp_path):
    from sqlalchemy import text

    from pipeline.index.object_store import ObjectStore
    from pipeline.index.pg_io import PgIO
    from pipeline.stage_base import StageContext

    io_ = PgIO.from_config(load_config())
    try:
        with io_.session() as s:
            s.execute(text("select 1"))
    except Exception:
        pytest.skip("PG 不可达(demo up 未起)")
    ctx = StageContext(config=load_config(), object_store=ObjectStore(tmp_path / "obj"), db=io_)
    batches: list[str] = []
    yield ctx, batches
    from sqlalchemy import delete, select

    from common.pg_models import (
        Chunk,
        Document,
        DocVersion,
        ImportBatch,
        PipelineEvent,
        ReviewQueue,
    )

    with io_.session() as s:
        dvs = list(s.scalars(select(DocVersion).where(DocVersion.batch_id.in_(batches or [""]))))
        dvids = [dv.doc_version_id for dv in dvs]
        lids = {dv.logical_id for dv in dvs}
        if dvids:
            s.execute(delete(Chunk).where(Chunk.doc_version_id.in_(dvids)))
            s.execute(delete(ReviewQueue).where(ReviewQueue.doc_version_id.in_(dvids)))
            s.execute(delete(PipelineEvent).where(PipelineEvent.doc_version_id.in_(dvids)))
            s.execute(delete(DocVersion).where(DocVersion.doc_version_id.in_(dvids)))
        if lids:
            s.execute(delete(Document).where(Document.logical_id.in_(lids)))
        if batches:
            s.execute(delete(ImportBatch).where(ImportBatch.batch_id.in_(batches)))


def test_s3_preseg_branch_lands_chunks(env, preseg_fixture):
    from sqlalchemy import select

    from common.pg_models import Chunk
    from pipeline.stages import s1_parse, s3_structure
    from pipeline.stages.s0_register import register_preseg_batch

    ctx, batches = env
    fixtures = preseg_fixture
    bid = "preseg-t7-s3"
    batches.append(bid)
    r = register_preseg_batch(ctx, bid, fixtures, fixtures / "manifest.xlsx")
    dvid = next(o.doc_version_id for o in r.outcomes if o.filename == "ext-001")
    s1_parse.start(ctx, dvid)
    s1_parse.run(ctx, dvid)
    res = s3_structure.run(ctx, dvid)
    assert res.next_state.value == "META_REVIEW"
    with ctx.db.session() as s:
        chunks = s.scalars(
            select(Chunk).where(Chunk.doc_version_id == dvid).order_by(Chunk.seq)
        ).all()
    norms = sorted(c.clause_path_norm for c in chunks)
    # ext-001:第一章(不成块)/第一条/第二十一条/第二十一条之一/伪路径块/表格块
    assert "1/1" in norms and "1/21" in norms and "1/21-1" in norms
    assert "preseg/4" in norms
    assert all(c.page_start is None for c in chunks)
    ets = {tuple(c.entity_type or []) for c in chunks}
    assert ets == {("证券公司", "证券从业人员")}  # D7 全块继承
    # CP-010:源条款锚落库(精确桥接键);伪路径块无锚
    by_norm = {c.clause_path_norm: c for c in chunks}
    assert by_norm["1/21"].source_code == "LC-EXT001-021"
    assert by_norm["preseg/4"].source_code is None
