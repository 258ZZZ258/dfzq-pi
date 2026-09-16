"""T2 推导器 golden 门:clause_label → DeriveResult,P=R=1.0(全样例逐字段精确)。

口径 = 实现现状(调研澄清①):norm 组件与 clause_tree 树派生一致(`/` 由 adapter 拼)、
插入条 `21-1`(normalize.py)、小数体例条号保留原样点分(classify_heading:111-113 同源)、
款级舍款取条 + kuan_raw 备查(决策 D5)。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline.preseg.derive import DeriveResult, derive_norm

GOLDEN = Path(__file__).parent / "golden" / "preseg_labels.jsonl"


def _cases():
    with GOLDEN.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: repr(c["label"])[:40])
def test_golden(case):
    r = derive_norm(case["label"])
    got = {"kind": r.kind, "norm": r.norm, "chapter": r.chapter,
           "section": r.section, "kuan_raw": r.kuan_raw}
    expected = {k: case[k] for k in got}
    assert got == expected


def test_golden_set_size():
    assert len(_cases()) >= 30  # TASKS T2 验收:≥30 样例


def test_result_is_frozen():
    r = derive_norm("第一条")
    with pytest.raises(AttributeError):
        r.norm = "2"  # type: ignore[misc]


def test_failure_is_explicit_not_raise():
    # 推导失败返回 kind=None(调用方落伪路径 preseg/{seq}),绝不 raise——入库不被脏标签阻塞
    assert derive_norm("!!!###").kind is None
    assert derive_norm(None).kind is None  # type: ignore[arg-type]


def test_norm_matches_tree_convention():
    """与树派生口径对齐:组件可直接参与 `/`-join(不含 `/` 字符本身)。"""
    for case in _cases():
        r: DeriveResult = derive_norm(case["label"])
        for comp in (r.norm, r.chapter, r.section):
            if comp is not None and "." not in comp:  # 小数体例条号本身含点,豁免
                assert "/" not in comp
