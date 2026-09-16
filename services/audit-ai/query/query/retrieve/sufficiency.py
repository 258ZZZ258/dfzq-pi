"""N5 充分性自检(§8.1):覆盖语境判据(非 top1 分数阈值)。

接口按 §8.1 **保真**——出参带 ``exhausted_scope``(已穷尽事项分区,供 §8.2 覆盖感知拒答);实现先
务实(事项分区高召回后命中数 ≥ 阈值即充分),升级到"事项分区穷尽"判据**不动调用方**(PLAN §2.5-3)。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Sufficiency:
    sufficient: bool
    exhausted_scope: list[str]  # 已穷尽检索的事项分区(§8.2 拒答附此)


def assess(candidates: Sequence, matters: Sequence[str], *, min_hits: int = 1) -> Sufficiency:
    """候选数 ≥ min_hits 即充分;``exhausted_scope`` = 已检索的事项分区(去重保序)。"""
    return Sufficiency(
        sufficient=len(candidates) >= max(1, min_hits),
        exhausted_scope=list(dict.fromkeys(matters)),
    )


def above_min_score(candidates: Sequence, min_score: float | None) -> list:
    """匹配度下限过滤(设计 A):保留重排相关性绝对分 ≥ ``min_score`` 的候选,喂充分性/生成。

    ``min_score=None`` → no-op(默认关)。**rerank 关时无候选带 ``rerank_score``**(全 None)→ 亦 no-op
    (不误杀,尤其无 dense 分的 sparse 精确命中)。过阈值后不足 ``min_hits`` 由调用方触发覆盖拒答;
    被剔候选仍由调用方从全量候选取「最接近 N 条」供人工核实(不静默丢)。
    """
    if min_score is None:
        return list(candidates)
    scored = [c for c in candidates if getattr(c, "rerank_score", None) is not None]
    if not scored:  # rerank 关(无绝对分)→ 阈值 no-op
        return list(candidates)
    return [c for c in scored if c.rerank_score >= min_score]
