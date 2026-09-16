"""§6.6 R6 统计型编排:维度抽取 → 参数化 SQL → 执行 → TABLE。**零 LLM、不走向量检索**。

只读 `cases`(经 `pg.session().execute`);统计数字逐字 PG 聚合(不臆造)。`violation_category` 是 L2
默认空字段 → 按事由聚合时 **consumed-when-present**:over present 值,含 NULL 桶则表注"未标注"。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import replace
from datetime import date
from decimal import Decimal

from query.contract import AnswerBlock, BlockType, QueryResult, RouteType
from query.stats.dimensions import GroupBy, StatSpec, extract_stat_spec
from query.stats.sql_builder import build_select

_GROUP_LABEL = {
    GroupBy.CATEGORY: "违规事由",
    GroupBy.ORG: "处罚机构",
    GroupBy.RESPONDENT_TYPE: "对象类型",
    GroupBy.YEAR: "年",
}
_METRIC_LABEL = {"count": "案件数", "sum_amount": "罚没金额(万元)"}
_LIST_COLS = ["文书ID", "标题", "处罚机构", "处罚日期", "对象类型", "处罚类型"]
_NO_DATA = "未检索到符合条件的案例统计。"
_UNLABELED = "（未标注）"
_CATEGORY_NOTE = "部分/全部案例的违规事由未标注(L2 默认关),按事由聚合仅覆盖已标注案例。"


def _fmt(v):
    """date → ISO;Decimal → int/float(PG EXTRACT/聚合返 Decimal,JSON 不可序列化);其余原样。"""
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    return v


def _table_block(spec: StatSpec, rows: list) -> AnswerBlock:
    if spec.mode == "list":
        content: dict = {"columns": _LIST_COLS, "rows": [[_fmt(v) for v in r] for r in rows]}
    else:
        cols = [_GROUP_LABEL[spec.group_by], _METRIC_LABEL[spec.metric]]
        data = [[_UNLABELED if k is None else _fmt(k), _fmt(val)] for (k, val) in rows]
        content = {"columns": cols, "rows": data}
        # consumed-when-present:CATEGORY 维度含 NULL 桶 → 明示未标注(不臆造)
        if spec.group_by is GroupBy.CATEGORY and any(k is None for (k, _) in rows):
            content["note"] = _CATEGORY_NOTE
    return AnswerBlock(BlockType.TABLE, json.dumps(content, ensure_ascii=False), stream=False)


def answer_stats(
    query: str,
    pg,
    *,
    perm_tags: Sequence[str] | None = None,
    corpus_types: Sequence[str] | None = None,
) -> QueryResult:
    """统计问句 → ``route_type=statistical`` 契约(TABLE 块)。空结果明示、citations 空。

    **R3**:接收 Java 预计算的授权位并下传 ``build_select``。

    为什么必须显式传参、而不是复用 ``Retriever`` 的 ``scoped()`` contextvar:这条路
    **根本不经 Retriever**(直查 PG),contextvar 在这里恒为空 —— 那正是 SPEC §9.3 记的
    现网越界(只授权 internal 的调用方问统计类问题能拿到全量 case 聚合)。

    两个参数都默认 None(= 不约束),既有调用方(会话式 ``/api/query/v1/*``)不传也不会崩;
    ``perm_tags`` 传空序列同样是「无额外限制」,那是边界契约明文。
    """
    spec = extract_stat_spec(query)
    spec = replace(
        spec,
        perm_tags=tuple(perm_tags) if perm_tags else None,
        corpus_types=tuple(corpus_types) if corpus_types else None,
    )
    with pg.session() as s:
        rows = s.execute(build_select(spec)).all()
    if not rows:
        return QueryResult(
            route_type=RouteType.STATISTICAL,
            answer_blocks=[AnswerBlock(BlockType.TEXT, _NO_DATA)],
            confidence=0.0,
        )
    return QueryResult(
        route_type=RouteType.STATISTICAL,
        answer_blocks=[_table_block(spec, rows)],
        confidence=0.5,  # ⚠ Q8 待标定:占位,不参与任何闸门
    )
