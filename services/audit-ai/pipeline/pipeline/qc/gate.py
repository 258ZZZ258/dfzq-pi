"""QC gate:按 profile 选指标集 → QcReport(任一不达标即 failed;任一落边缘带即 marginal)。

P-INT/P-EXT 跑条款树全七项;P-QA 跑问答四项(见 ``indicators.indicators_for``)。
"""

from __future__ import annotations

from dataclasses import dataclass

from common.ir import IRDocument
from pipeline.config import QcThresholds
from pipeline.qc.indicators import IndicatorResult, indicators_for


@dataclass
class QcReport:
    indicators: list[IndicatorResult]

    @property
    def failed(self) -> bool:
        return any(not i.passed for i in self.indicators)

    @property
    def marginal(self) -> bool:
        return any(i.marginal for i in self.indicators)

    def failures(self) -> list[IndicatorResult]:
        return [i for i in self.indicators if not i.passed]

    def to_evidence(self) -> dict:
        return {
            "failed": [
                {"index": i.index, "name": i.name, "value": round(i.value, 4),
                 "threshold": i.threshold, "evidence": i.evidence}
                for i in self.failures()
            ],
            "marginal": [i.name for i in self.indicators if i.marginal],
        }


def evaluate(
    ir: IRDocument, thresholds: QcThresholds, corpus_type: str = "P-INT", profile=None
) -> QcReport:
    """按 corpus_type 选指标集跑 QC(profile 配置优先,缺失回退硬编码默认,CP-010 T1)。

    profile.qc_threshold_overrides 以**副本**覆盖阈值(model_copy),不污染全局 Settings。
    """
    overrides = getattr(profile, "qc_threshold_overrides", None)
    if overrides:
        thresholds = thresholds.model_copy(update=overrides)
    return QcReport([fn(ir, thresholds) for fn in indicators_for(corpus_type, profile)])
