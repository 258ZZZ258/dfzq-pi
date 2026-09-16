"""§6.6 参数化 SQL 构造(防注入核心,纯函数)。

红线:聚合/过滤列**只来自 `GroupBy` 白名单 → 真实 Column**;过滤值经 SQLAlchemy 算子**自动绑定为
bound params**;用户问句只经 `dimensions` 规则映射到枚举/标量,**绝不拼接进 SQL**(SPEC-R6 §7 Never)。

**可见性**(对齐查询侧 `status=effective` 强过滤):`cases` 在 S4 即 upsert,文档可能尚未 INDEXED
(META_REVIEW)或为旧版/未上线;故所有 R6 查询统一 join `doc_versions`,只统计
``pipeline_status==INDEXED`` ∧ ``version_status==effective`` 的可见案例(SPEC §7 / RTM §2-status)。
"""

from __future__ import annotations

from sqlalchemy import Integer, Select, cast, extract, func, select

from common.pg_models import Case, Document, DocVersion
from query.stats.dimensions import GroupBy, StatSpec

#: ⚠ 列表型下钻上限
_LIST_CAP = 50

#: group_by 白名单:枚举 → 真实 Column / 派生表达式(**绝不接受用户串**)
#: YEAR cast 成 Integer——PG ``EXTRACT`` 返 ``Decimal``,不 cast 则 ``json.dumps`` 抛 TypeError。
_GROUP_COL = {
    GroupBy.CATEGORY: Case.violation_category,
    GroupBy.ORG: Case.penalty_org,
    GroupBy.RESPONDENT_TYPE: Case.respondent_type,
    GroupBy.YEAR: cast(extract("year", Case.penalty_date), Integer),
}


#: 边界 corpus_types → Document.corpus_type 的存储值。与 routes_boundary._CORPUS_MAP 同源。
#: ⚠ 库里存的是 Milvus 分区名 P-INT/P-EXT,**不是** internal/external —— 用错会静默匹配不上,
#: 聚合恒空而测试看起来「通过」。
_CORPUS_STORAGE = {"internal": "P-INT", "external": "P-EXT", "qa": "P-QA", "case": "P-CASE"}

#: 未知 corpus_type 的替身。任何真实 corpus_type 都不会等于它 ⇒ IN (...) 恒不命中。
_UNMATCHABLE_CORPUS = "__unmapped_corpus_type__"


def _visibility_conds(spec: StatSpec | None = None) -> list:
    """可见性 + **权限约束**(R2)。

    可见性:INDEXED + effective(对齐查询侧默认过滤)。

    权限(R2,堵 SPEC §9.3 记的现网越界):`answer_stats` 直查 PG、不经 `Retriever`,
    `scoped()` 的 contextvar 在这条路上**完全无效** —— 只授权 internal 的调用方问统计类问题
    能拿到全量 case 聚合。`citations` 为空所以不泄条款 id,**但聚合结果本身即答案**。

    `cases` 表自身没有权限字段:perm_tag 在 `doc_versions` 上、corpus_type 在 `documents` 上,
    所以要沿 `Case.doc_version_id → DocVersion.logical_id → Document` 两跳。
    """
    conds = [
        DocVersion.pipeline_status == "INDEXED",
        DocVersion.version_status == "effective",
    ]
    if spec is None:
        return conds
    # 空 perm_tags = 无额外限制(契约明文,非 fail-open)。实现成「空 ⇒ 匹配不到任何 tag」
    # 会让统计恒空 —— 一个静默的功能损坏,不是更安全。
    if spec.perm_tags:
        conds.append(DocVersion.perm_tag.in_(list(spec.perm_tags)))
    if spec.corpus_types:
        # 未知类型映射为一个**不可能匹配**的普通字符串,收窄到空 ——
        # 绝不能因为「映射不到」而退化成无约束(那样「internal + 乱写一个」就成了提权)。
        #
        # ⚠ 不要用 "\x00" 之类的哨兵:PostgreSQL 的 text 字段不接受 NUL 字节,
        # 整个查询会抛 DataError。抛异常在这里**恰好**也是 fail-closed,但它是运行时错误
        # 而不是授权判定 —— 上游一个 except 就会把它变成静默放行。
        stored = [_CORPUS_STORAGE.get(c, _UNMATCHABLE_CORPUS) for c in spec.corpus_types]
        conds.append(Document.corpus_type.in_(stored))
    return conds


def _filters(spec: StatSpec) -> list:
    """可见性 + 维度过滤;值全经算子绑定为 bound params(年/机构含)。"""
    conds = _visibility_conds(spec)
    if spec.year_from is not None:
        conds.append(extract("year", Case.penalty_date) >= spec.year_from)
    if spec.year_eq is not None:
        conds.append(extract("year", Case.penalty_date) == spec.year_eq)
    if spec.org_like:
        conds.append(Case.penalty_org.like(f"%{spec.org_like}%"))  # 整 pattern 作 bound param
    return conds


def build_select(spec: StatSpec) -> Select:
    """``StatSpec`` → SQLAlchemy ``Select``(白名单列 + bound params + 可见性 join)。

    list:cases 卡片列(join doc_versions 取标题 + 可见性)按 ``penalty_date`` 降序取 ``_LIST_CAP``。
    aggregate:白名单维度 GROUP BY + count / sum(amount_wan) 降序(join doc_versions 仅作可见性过滤)。
    """
    conds = _filters(spec)
    join_on = Case.doc_version_id == DocVersion.doc_version_id
    # 只在真要用 corpus_type 时才 join documents:logical_id 是 FK 且 documents 主键唯一,
    # 这个 join 不会放大行数,但无谓的 join 会让既有查询计划变复杂。
    needs_document = bool(spec.corpus_types)
    if spec.mode == "list":
        return (
            select(
                Case.doc_version_id,
                DocVersion.title,
                Case.penalty_org,
                Case.penalty_date,
                Case.respondent_type,
                Case.penalty_type,
            )
            .join(DocVersion, join_on)
            .join(Document, DocVersion.logical_id == Document.logical_id)
            .where(*conds)
            .order_by(Case.penalty_date.desc())
            .limit(_LIST_CAP)
        ) if needs_document else (
            select(
                Case.doc_version_id,
                DocVersion.title,
                Case.penalty_org,
                Case.penalty_date,
                Case.respondent_type,
                Case.penalty_type,
            )
            .join(DocVersion, join_on)
            .where(*conds)
            .order_by(Case.penalty_date.desc())
            .limit(_LIST_CAP)
        )

    group_col = _GROUP_COL[spec.group_by]  # 非白名单枚举 → KeyError(防注入)
    metric = func.sum(Case.amount_wan) if spec.metric == "sum_amount" else func.count()
    stmt = select(group_col.label("key"), metric.label("value")).join(DocVersion, join_on)
    if needs_document:
        stmt = stmt.join(Document, DocVersion.logical_id == Document.logical_id)
    return stmt.where(*conds).group_by(group_col).order_by(metric.desc())
