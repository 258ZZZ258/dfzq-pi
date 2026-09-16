"""dm_sink 映射层单测(CP-013):解析产物 → 达梦 8 表行。"""

from __future__ import annotations

from datetime import datetime

import pytest

from common.ir import Block, BlockType, Table, TableCell
from pipeline.chunking.clause_tree import build_tree
from pipeline.dm_sink.codes import content_code, law_code, snowflake_id
from pipeline.dm_sink.mapper import DmSinkError, levels_of, map_document
from pipeline.preseg.export import blocks_from_contents

NOW = datetime(2026, 7, 27, 10, 0, 0)

BASE_ROW = {
    "filename": "test.docx", "title": "某某管理办法", "doc_number": "第1号",
    "issuer": "中国证券监督管理委员会", "perm_tag": "公开", "corpus_type": "P-EXT",
    "sub_type": "部门规章", "biz_domain": "信息披露",
    "issue_date": "2026-01-01", "effective_date": "2026-03-01", "supersedes": None,
}


def blocks_of(*texts: str) -> list[Block]:
    return [
        Block(index=i, type=BlockType.PARAGRAPH, text=t) for i, t in enumerate(texts)
    ]


def build(texts: list[str], row: dict | None = None):
    bs = blocks_of(*texts)
    return map_document({**BASE_ROW, **(row or {})}, bs, build_tree(bs), now=NOW)


def body_of(dm, code: str) -> str:
    """某条款节点的正文 = 其详情段按 CONTENT_ORDER 拼接(与 preseg.export 的读法同口径)。"""
    segs = sorted(
        (d for d in dm.content_details if d["law_content_code"] == code),
        key=lambda d: d["content_order"],
    )
    return "\n".join(d["content"] for d in segs)


def bodies(dm) -> dict[str, str]:
    """条款标识 → 正文(只取有正文的节点)。"""
    out = {}
    for r in dm.contents:
        text = body_of(dm, r["code"])
        if text:
            out[r["title"]] = text
    return out


def _upper(rows: list[dict]) -> list[dict]:
    """dm_sink 行(小写键,直接落库)→ 转换层认的大写键(DmSource._rows 的归一)。"""
    return [{k.upper(): v for k, v in r.items()} for r in rows]


# ── 标识生成:确定性 = 幂等之根 ────────────────────────────────────────────


def test_law_code_deterministic_and_shaped():
    a, b = law_code("x.docx"), law_code("x.docx")
    assert a == b, "同输入必须同 CODE,否则重跑堆重复法规而非覆盖"
    assert a != law_code("y.docx")
    assert len(a) == 36 and a.startswith("ELA7")


def test_content_code_pads_to_three_and_widens_beyond_999():
    law = law_code("x")
    assert content_code(law, 7).endswith("007")
    assert len(content_code(law, 7)) == 39
    # 《民法典》级别的大法规会越过 3 位,序号自然变宽而不是截断/回绕
    assert content_code(law, 1234).endswith("1234")


def test_snowflake_id_is_19_digits_and_stable():
    i = snowflake_id("k")
    assert i == snowflake_id("k") and len(i) == 19 and i.isdigit()


# ── LEVELS:JSON 数组串,不是裸值 ─────────────────────────────────────────


def test_levels_is_json_array_string():
    assert levels_of("部门规章") == '["DEPARTMENTAL_RULES"]'
    assert levels_of("未知类型") == '["未知类型"]', "未命中映射表也须保持数组形态"
    assert levels_of(None) == "", "空 → 空串(真库有 4 条空值,合法)"


# ── 条款树 → LAW_CONTENT ─────────────────────────────────────────────────


def test_root_node_then_catalog_then_articles():
    dm = build(["第一章 总则", "第一条 为了规范……", "第二条 本办法适用于……"])
    rows = dm.contents
    assert rows[0]["index_no"] == 0
    assert rows[0]["is_catalog"] == 0 and rows[0]["title"] == "" and rows[0]["content"] == ""
    assert rows[1]["is_catalog"] == 1 and "第一章" in rows[1]["title"]
    assert list(bodies(dm)) == ["第一条", "第二条"]


def test_article_title_is_bare_label_not_body():
    """小数编号体例的条标题行**就是正文段落**,TITLE 只能放标识 —— 否则下游推导器必失配。"""
    dm = build(["第一章 总则", "1.1 为了规范本所股票上市,根据有关规定,制定本规则。"])
    art = next(r for r in dm.contents if body_of(dm, r["code"]))
    assert art["title"] == "1.1"
    assert "为了规范" in body_of(dm, art["code"]), "正文须完整落在详情表"
    assert "为了规范" not in art["title"]


def test_path_code_catalog_self_article_prefixed():
    dm = build(["第一章 总则", "第一条 正文内容甲乙丙。"])
    cat = next(r for r in dm.contents if r["is_catalog"] == 1)
    art = next(r for r in dm.contents if body_of(dm, r["code"]))
    assert cat["path_code"] == cat["code"], "章的 PATH_CODE = 自身 CODE(同甲方,不串祖先链)"
    assert art["path_code"] == f"{cat['code']}.{art['code']}"


# ── 正文落点:与真库同构(主表空,正文在 LAW_CONTENT_DETAIL)────────────────


def test_main_content_is_blank_and_body_lives_in_detail_table():
    """真库在册 LAW_CONTENT.CONTENT 几乎全空、正文在详情表(2026-07-29 内网复核)。

    我方写回甲方库必须同构:否则甲方库里同时存在两种正文落点,而"每个事实单一源"被打破,
    详情表的同序冲突检测也没法判哪份权威。
    """
    dm = build(["第一章 总则", "第一条 甲乙丙。", "第二条 丁。"])
    assert all(r["content"] == "" for r in dm.contents), "主表正文一律置空"
    assert bodies(dm) == {"第一条": "第一条 甲乙丙。", "第二条": "第二条 丁。"}
    assert all(d["content_type"] == 0 for d in dm.content_details), "纯文本段恒 CONTENT_TYPE=0"
    assert all(d["del_flag"] == "A" for d in dm.content_details)


def test_detail_segments_are_per_block_and_ordered():
    """CONTENT_ORDER = 同一条款下的文本片段顺序 —— 款/项各自成段,不塞成一坨。"""
    dm = build(["第一条 甲乙丙。", "(一)子项一。", "(二)子项二。"])
    art = next(r for r in dm.contents if body_of(dm, r["code"]))
    segs = sorted(
        (d for d in dm.content_details if d["law_content_code"] == art["code"]),
        key=lambda d: d["content_order"],
    )
    assert [d["content_order"] for d in segs] == [0, 1, 2], "顺序号从 0 连续"
    assert [d["content"] for d in segs] == ["第一条 甲乙丙。", "(一)子项一。", "(二)子项二。"]
    assert all(d["law_code"] == dm.code for d in segs)


def test_detail_ids_deterministic_across_runs():
    """幂等之根:同文档两次映射产出同一批详情 ID(写库按 CODE 覆盖才不堆重复)。"""
    a, b = build(["第一条 甲。", "第二条 乙。"]), build(["第一条 甲。", "第二条 乙。"])
    assert [d["id"] for d in a.content_details] == [d["id"] for d in b.content_details]
    assert len({d["id"] for d in a.content_details}) == len(a.content_details), "ID 不得撞"


def test_roundtrips_through_preseg_export_detail_fallback():
    """CP-013 → CP-010 闭环:我方写达梦(正文进详情表)→ preseg 导出按详情回退读回。

    读回的块文本必须与映射前的段落逐字一致 —— 否则写库形态与读库口径对不上,
    整条"文档解析 → 达梦 → 回灌 PG/Milvus"的链路会在正文上失真。
    """
    dm = build(["第一章 总则", "第一条 甲乙丙。", "(一)子项一。", "(二)子项二。", "第二条 丁。"])
    blocks = blocks_from_contents(
        _upper(dm.contents), [], content_details=_upper(dm.content_details)
    )
    got_parts: dict[str, list[str]] = {}
    for block in blocks:
        if block["is_catalog"]:
            continue
        got_parts.setdefault(block["clause_label"], []).append(block["text"])
    got = {label: "\n".join(parts) for label, parts in got_parts.items()}
    assert got == {
        "第一条": "第一条 甲乙丙。\n(一)子项一。\n(二)子项二。",
        "第二条": "第二条 丁。",
    }
    # 章节标题块仍靠 TITLE 兜底成块(主表正文为空不影响它)
    assert [b["text"] for b in blocks if b["is_catalog"]] == ["第一章 总则"]


def test_index_no_is_contiguous_preorder():
    dm = build(["第一章 总则", "第一条 甲。", "第二条 乙。", "第二章 分则", "第三条 丙。"])
    assert [r["index_no"] for r in dm.contents] == list(range(len(dm.contents)))


def test_每节点只写一行():
    """甲方每逻辑节点有 2 物理行(其 ETL 缺陷),我方写 1 行。"""
    dm = build(["第一章 总则", "第一条 甲乙丙。"])
    codes = [r["code"] for r in dm.contents]
    assert len(codes) == len(set(codes))


# ── 兜底:无条款体文档不得静默丢失 ────────────────────────────────────────


def test_plain_document_falls_back_to_paragraph_nodes():
    """无「第X条」体例(实测真语料 22% 如此):须切出正文节点,否则下游按无正文整件跳过。"""
    dm = build(["关于发布业务办理指南的公告", "一、办理流程如下。", "二、材料要求如下。"])
    bodied = [r for r in dm.contents if body_of(dm, r["code"])]
    assert bodied, "无条款体文档也必须产出正文节点"
    assert dm.law["has_content"] == 1, "has_content 须按详情表判,不能再看主表 CONTENT"
    assert "办理流程" in "\n".join(body_of(dm, r["code"]) for r in bodied)


def test_plain_fallback_groups_by_token_budget():
    dm = build(["公告标题", *[f"第{i}段正文内容。" * 40 for i in range(6)]],)
    bodied = [r for r in dm.contents if body_of(dm, r["code"])]
    assert len(bodied) > 1, "超预算须拆成多个节点,不塞成一个巨块"


def test_has_content_zero_when_no_body_at_all():
    """只有表格 → 正文段为空 → HAS_CONTENT=0(甲方据此判有无正文;表格不进纯文本正文)。"""
    table = Table(n_rows=1, n_cols=2, cells=[
        TableCell(text="表头", row=0, col=0), TableCell(text="表体", row=0, col=1),
    ])
    bs = [Block(index=0, type=BlockType.TABLE, text="表头|表体", table=table)]
    dm = map_document(BASE_ROW, bs, build_tree(bs), now=NOW)
    assert dm.content_details == [], "表格块不产出正文段"
    assert dm.law["has_content"] == 0


# ── LAW_BASIC ────────────────────────────────────────────────────────────


def test_law_basic_maps_scope_and_placeholders():
    dm = build(["第一条 甲。"])
    law = dm.law
    assert law["scope"] == 0 and law["status_code"] == "inuse" and law["del_flag"] == "A"
    assert law["name"] == "某某管理办法" and law["doc_no"] == "第1号"
    # 版本链三字段:与甲方一致用占位空串而非 NULL
    assert law["source_law_id"] == "" and law["new_code"] == "" and law["abolish_code"] == ""
    assert law["effect_date"].isoformat() == "2026-03-01"


def test_internal_corpus_maps_to_scope_1():
    dm = build(["第一条 甲。"], {"corpus_type": "P-INT"})
    assert dm.law["scope"] == 1


def test_effect_date_falls_back_to_issue_date():
    dm = build(["第一条 甲。"], {"effective_date": None})
    assert dm.law["effect_date"].isoformat() == "2026-01-01"


@pytest.mark.parametrize("corpus", ["P-QA", "P-CASE", "", "unknown"])
def test_non_law_corpus_rejected(corpus):
    """达梦无问答表、案例走 CASE_* 三表 → 不能硬塞进 LAW_BASIC 污染法规库。"""
    with pytest.raises(DmSinkError):
        build(["第一条 甲。"], {"corpus_type": corpus})


def test_same_document_maps_to_same_codes():
    """幂等:同一文档两次映射产出完全相同的 CODE 集合(写库侧据此按 CODE 覆盖)。"""
    a = build(["第一章 总则", "第一条 甲。"])
    b = build(["第一章 总则", "第一条 甲。"])
    assert a.code == b.code
    assert [r["code"] for r in a.contents] == [r["code"] for r in b.contents]
