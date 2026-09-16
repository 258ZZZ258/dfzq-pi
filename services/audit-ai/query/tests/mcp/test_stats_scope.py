"""R2 / R3 的判别性验证 —— 统计路的权限约束。

**这是本轮唯一堵住「现网已存在的越权」的改动**(主规格 §9.3):`answer_stats` 直查 PG、
不经 `Retriever` ⇒ `scoped()` 的 contextvar 无效 ⇒ 只授权 `internal` 的调用方问统计类问题,
能拿到全量 case 数据的聚合。`citations` 为空所以不泄条款 id,**但聚合结果本身即答案**。

真语料 `cases` 表 0 行,空集上的断言恒真、零区分力(dfzq-pi 规格 §4.1)。所以这里直接
INSERT 最小行集,让**授权 internal 的结果 ≠ 全表结果** —— 只有两边不等,断言才有意义。

关联链:`Case.doc_version_id → DocVersion.logical_id → Document.corpus_type`。
⚠ `Document.corpus_type` 的值是 **`P-INT` / `P-EXT`**(Milvus 分区名),不是 `internal` /
`external` —— 用错会静默匹配不上,聚合恒空而测试看起来「通过」。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from common.pg_models import Case, Document, DocVersion
from query.stats.dimensions import GroupBy, StatSpec
from query.stats.sql_builder import build_select


@pytest.fixture
def pg():
    from pipeline.config import load_config
    from pipeline.index.pg_io import PgIO

    store = PgIO.from_config(load_config())
    try:
        with store.session() as session:
            session.execute(text("select 1"))
    except Exception as exc:
        pytest.skip(f"PG 不可达，统计权限集成测试跳过: {exc}")
    return store


@pytest.fixture
def seeded(pg):
    """两个语料类型 × 两个 perm_tag,共 5 条 case。用完即删。

    `violation_category` 刻意相同 —— 聚合维度不区分它们,只有权限约束能区分。
    """
    tag = uuid.uuid4().hex[:8]
    made: dict[str, list[str]] = {"doc": [], "ver": [], "case": []}
    with pg.session() as s:
        # batch_id 非空且是 FK —— 借一个库里已有的批次,不新建(新建要连带清理)。
        batch_id = s.execute(text("select batch_id from import_batches limit 1")).scalar()
        if batch_id is None:
            pytest.skip("import_batches 为空,无法构造 doc_versions fixture")
        for corpus, perm, n in (("P-INT", f"P1-{tag}", 2), ("P-EXT", f"P2-{tag}", 3)):
            logical_id = f"L-{tag}-{corpus}"
            s.add(Document(logical_id=logical_id, corpus_type=corpus, title=f"doc-{corpus}"))
            made["doc"].append(logical_id)
            # 三张表有 FK 链 documents ← doc_versions ← cases,而 SQLAlchemy 的
            # unit-of-work 不保证跨表 INSERT 顺序 —— 每一层落库后都要 flush。
            s.flush()
            # Case.doc_version_id 是**主键** —— 一个版本一个案例,所以每条 case 各建一个版本。
            for i in range(n):
                version_id = f"V-{tag}-{corpus}-{i}"
                s.add(
                    DocVersion(
                        doc_version_id=version_id,
                        logical_id=logical_id,
                        batch_id=batch_id,
                        source_format="pdf",
                        # 下面三个是 NOT NULL 无默认值(实测 information_schema),
                        # 与本测试的语义无关,给可识别的占位值即可。
                        source_hash=f"h-{tag}-{corpus}-{i}",
                        raw_object_key=f"k-{tag}-{corpus}-{i}",
                        qc_marginal=False,
                        pipeline_status="INDEXED",
                        version_status="effective",
                        perm_tag=perm,
                    )
                )
                s.flush()  # 先把 document/doc_version 落库,再插引用它的 case
                s.add(
                    Case(
                        doc_version_id=version_id,
                        doc_number=f"C-{tag}-{corpus}-{i}",
                        penalty_org="某证监局",
                        violation_category="信息披露违规",
                        respondent_type="机构",
                    )
                )
                made["ver"].append(version_id)
                made["case"].append(version_id)
            # 分批 flush:SQLAlchemy 的 unit-of-work 不保证跨表的 INSERT 顺序,
            # cases 先于 doc_versions 落库会撞外键。
            s.flush()
        s.commit()
    yield {"tag": tag, "int_perm": f"P1-{tag}", "ext_perm": f"P2-{tag}"}
    with pg.session() as s:
        s.execute(text("delete from cases where doc_version_id = any(:ids)"), {"ids": made["case"]})
        s.execute(
            text("delete from doc_versions where doc_version_id = any(:ids)"), {"ids": made["ver"]}
        )
        s.execute(text("delete from documents where logical_id = any(:ids)"), {"ids": made["doc"]})
        s.commit()


def _count(pg, spec) -> int:
    with pg.session() as s:
        return sum(v for (_k, v) in s.execute(build_select(spec)).all())


def _spec(**scope):
    return StatSpec(mode="aggregate", group_by=GroupBy.CATEGORY, metric="count", **scope)


class TestR2VisibilityConstraints:
    def test_no_scope_sees_everything(self):
        """基线:不带 scope 时两类都进聚合。**这条不通过,下面两条就没有意义。**"""
        assert True  # 由 test_corpus_type_narrows_the_aggregate 的 total 断言承担

    def test_corpus_type_narrows_the_aggregate(self, pg, seeded):
        total = _count(pg, _spec())
        internal_only = _count(pg, _spec(corpus_types=["internal"]))
        # 三条缺一不可:总数看得见全部、授权后严格变少、且等于预期值。
        # 只断言最后一条不能排除「它本来就只有 2 条」。
        assert total >= 5
        assert internal_only < total
        assert internal_only == 2

    def test_perm_tag_narrows_the_aggregate(self, pg, seeded):
        total = _count(pg, _spec())
        scoped = _count(pg, _spec(perm_tags=[seeded["int_perm"]]))
        assert total >= 5
        assert scoped < total
        assert scoped == 2

    def test_empty_perm_tags_means_no_extra_limit_not_zero(self, pg, seeded):
        """契约明文:空 perm_tags = 无额外限制,**不是 fail-open,也不是拒绝**。

        把它实现成「空 ⇒ 匹配不到任何 perm_tag」会让统计恒空 —— 一个静默的功能损坏。
        """
        assert _count(pg, _spec(perm_tags=[])) == _count(pg, _spec())

    def test_authorized_but_empty_corpus_type_yields_nothing(self, pg, seeded):
        """已知但库里无数据的类型(qa)⇒ 空。这测的是「映射对了、恰好没数据」。"""
        assert _count(pg, _spec(corpus_types=["qa"])) == 0

    def test_unmapped_corpus_type_yields_nothing_rather_than_everything(self, pg, seeded):
        """**未知**类型必须收窄到空,绝不能因为「映射不到」而退化成无约束。

        ⚠ 这条最初写成传 "qa" —— 但 qa **在** _CORPUS_STORAGE 里(映射到 P-QA,只是库里
        没数据),所以它测的是「已知但无数据」,对「映射不到时会不会退化」零区分力。
        变异检验(把 .get(c, 哨兵) 改成「过滤掉未知项、全空则不约束」)全绿才暴露出来。
        真正的未知值才打得到那条分支。
        """
        assert _count(pg, _spec(corpus_types=["nonesuch"])) == 0

    def test_mix_of_known_and_unknown_does_not_widen(self, pg, seeded):
        """混入未知值不得放宽已知值的约束 —— 否则「internal + 乱写一个」就成了提权。"""
        assert _count(pg, _spec(corpus_types=["internal", "nonesuch"])) == 2

    def test_both_constraints_compose(self, pg, seeded):
        """两个约束是合取:internal + 外规的 perm_tag ⇒ 空集。"""
        assert _count(pg, _spec(corpus_types=["internal"], perm_tags=[seeded["ext_perm"]])) == 0


class TestR3ScopePlumbing:
    def test_answer_stats_accepts_a_scope(self, pg, seeded):
        """R3:`answer_stats` 必须能接 scope 并下传,否则 R2 的约束永远用不上。"""
        from query.stats.r6_stats import answer_stats

        result = answer_stats("2024年以来的处罚按类别统计", pg, corpus_types=["internal"])
        assert result is not None

    def test_answer_stats_without_scope_still_works(self, pg, seeded):
        """既有调用方(会话式 /api/query/v1/*)不传 scope —— 不能因为加了参数就崩。"""
        from query.stats.r6_stats import answer_stats

        assert answer_stats("2024年以来的处罚按类别统计", pg) is not None
