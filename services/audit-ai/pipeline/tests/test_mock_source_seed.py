"""仿真达梦数据的正文落点必须与真实库一致。"""

from __future__ import annotations

import random

import pytest

from pipeline.preseg.export import PresegExportError, blocks_from_contents
from tools.mock_source import seed


def _seed_with_edges(rng: random.Random) -> tuple[list[dict], list[dict], dict[str, str]]:
    """跑一遍 ``--edge-cases`` 造数链,返回 (条款树行, 详情行, 边缘 key → 法规 CODE)。"""
    laws = seed.gen_laws(rng, 3)
    edges = seed.gen_edge_laws(rng, len(laws))
    edge_codes = {key: row["code"] for (key, _, _), row in zip(seed.EDGE_LAWS, edges, strict=True)}
    laws.extend(edges)
    contents = seed.gen_contents(rng, laws)
    details = seed.gen_content_details(rng, contents)
    contents, details = seed.apply_content_edges(contents, details, edge_codes)
    return contents, details, edge_codes


def test_seed_moves_clause_text_from_main_content_to_detail_rows():
    laws = seed.gen_laws(random.Random(7), 1)
    contents = seed.gen_contents(random.Random(8), laws)
    original_text_by_code = {
        row["code"]: row["content"]
        for row in contents
        if row["content"]
    }

    details = seed.gen_content_details(random.Random(9), contents)

    assert original_text_by_code
    assert all(row["content"] == "" for row in contents)
    detail_text_by_code = {
        row["law_content_code"]: row["content"]
        for row in details
        if row["content_type"] == 0
    }
    assert detail_text_by_code == original_text_by_code


def test_edge_cases_build_a_detail_conflict_the_export_actually_rejects():
    """``--edge-cases`` 必须造出「同条款同顺序、正文不同」的详情段,且导出真的拒收该法规。

    正文搬进详情表后,主表 ``CONTENT`` 恒为空,靠它挑冲突目标会静默失效:``INDEX_NO=0`` 的
    根节点正是「非目录 + 无正文」,详情表里根本没有它,冲突样本一条都造不出来 —— 于是
    ``_detail_text_by_content_code`` 的 fail-closed 拒收分支没有数据能走到(等于没实现),
    ``verify.py`` 的 ``content-conflict`` 断言也永远失败。断言走完整导出路径,而非只看造数产物。
    """
    contents, details, edge_codes = _seed_with_edges(random.Random(11))
    conflict_law = edge_codes["content-conflict"]

    by_order: dict[tuple[str, int], set[str]] = {}
    for d in details:
        if d["content_type"] == 0:
            key = (d["law_content_code"], d["content_order"])
            by_order.setdefault(key, set()).add(d["content"])
    conflicts = {k: v for k, v in by_order.items() if len(v) > 1}
    assert conflicts, "--edge-cases 未造出任何同条款同顺序的详情冲突"
    assert all(code.startswith(conflict_law) for code, _ in conflicts), (
        "详情冲突只应落在 content-conflict 这部边缘法规上"
    )

    law_contents = [r for r in contents if r["law_code"] == conflict_law]
    law_details = [r for r in details if r["law_code"] == conflict_law]
    with pytest.raises(PresegExportError, match="同条款同顺序正文冲突"):
        blocks_from_contents(_upper(law_contents), [], content_details=_upper(law_details))


def _upper(rows: list[dict]) -> list[dict]:
    """seed 行(小写键,直接落 PG)→ 转换层认的大写键(DmSource._rows 的归一)。"""
    return [{k.upper(): v for k, v in row.items()} for row in rows]
