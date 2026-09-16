"""§8.1 匹配度下限门(设计 A:弱匹配→覆盖拒答)单元:零栈。

覆盖:above_min_score 过滤(None no-op / rerank 关 no-op / 阈值过滤 / 混合)· reranker.rerank_scored
分数管道(none 全 None / api 打分+补回)· Candidate.rerank_score 字段 + replace 写回。
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

from query.rerank.reranker import NoneReranker
from query.retrieve.hybrid import Candidate
from query.retrieve.sufficiency import above_min_score


def _cand(cid, *, rerank_score=None):
    return Candidate(cid, 1.0, "P-INT", "DV1", "1/1", 1, False, "hybrid", rerank_score=rerank_score)


# ── above_min_score ─────────────────────────────────────────────


def test_min_score_none_is_noop():
    cands = [_cand("a", rerank_score=0.1), _cand("b", rerank_score=0.9)]
    assert above_min_score(cands, None) == cands  # 关 → 全返


def test_rerank_off_no_score_is_noop():
    # rerank 关:候选无 rerank_score(全 None)→ 阈值 no-op(不误杀 sparse 精确命中)
    cands = [_cand("a"), _cand("b")]
    assert above_min_score(cands, 0.5) == cands


def test_filters_below_threshold():
    cands = [_cand("a", rerank_score=0.2), _cand("b", rerank_score=0.8),
             _cand("c", rerank_score=0.5)]
    kept = above_min_score(cands, 0.5)
    assert [c.chunk_id for c in kept] == ["b", "c"]  # 0.2 剔除;0.5 边界保留(>=)


def test_starves_to_empty_when_all_below():
    # 全低于阈值 → 空作答集(调用方据此触发覆盖拒答)
    cands = [_cand("a", rerank_score=0.1), _cand("b", rerank_score=0.2)]
    assert above_min_score(cands, 0.5) == []


def test_mixed_scored_and_none_keeps_only_scored_above():
    # api top_n 截断:部分打分、部分补回 None → 仅保留打分且过阈值者(未打分的尾部剔除)
    cands = [_cand("a", rerank_score=0.9), _cand("b"), _cand("c", rerank_score=0.1)]
    assert [c.chunk_id for c in above_min_score(cands, 0.5)] == ["a"]


# ── Candidate 字段 + replace 写回(retrieve 的做法)─────────────────


def test_candidate_rerank_score_default_none_and_replace():
    c = Candidate("a", 1.0, "P-INT", "DV1", "1/1", 1, False, "hybrid")
    assert c.rerank_score is None                       # add-only 默认 None(向后兼容位置构造)
    assert replace(c, rerank_score=0.7).rerank_score == 0.7


# ── reranker.rerank_scored 分数管道 ─────────────────────────────


def test_none_reranker_scored_all_none():
    cands = [SimpleNamespace(chunk_id="a", text="t"), SimpleNamespace(chunk_id="b", text="u")]
    scored = NoneReranker().rerank_scored("q", cands)
    assert [s for _, s in scored] == [None, None]       # 无打分器 → 无绝对分
    assert NoneReranker().rerank("q", cands) == cands    # rerank 仍 passthrough


def test_retrieve_persist_pattern():
    # 复现 retrieve 的写回:rerank_scored → replace(rerank_score);再 above_min_score 过滤
    cands = [_cand("a"), _cand("b")]
    fake_scored = [(cands[1], 0.8), (cands[0], 0.3)]     # 模拟重排器返回(重排序 + 分)
    persisted = [replace(c, rerank_score=s) if s is not None else c for c, s in fake_scored]
    kept = above_min_score(persisted, 0.5)
    assert [c.chunk_id for c in kept] == ["b"]           # 0.8 留、0.3 剔
