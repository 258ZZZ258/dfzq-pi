"""audit-biz → audit-ai 边界二:无状态 ``POST /v1/query`` JSON 薄壳。

独立于前端向 ``/api/query/v1/*`` 会话式 API:无用户身份、无会话落库、无导出;引用只回轻量
标识(clause_id/chunk_id/score),四级回查归 Java(§8.2 收口)。Java 预计算的 ``filters`` 经
``Retriever.scoped`` 下推为 Milvus **前置过滤**(检索**前**生效,红线:算在 Java、用在 Python);
per-hit 分数从**同一次**检索的候选收集槽派生,不二次检索。

已知限制(详见 ``docs/query-agent-docs/BOUNDARY-v1-query-api.md``):薄壳不改 AI 内核 →
正文生成仍依赖 PG 权威全文(契约「热路径不依赖 PG」措辞待修);``delta`` 按契约允许的
整块返回。浏览器侧轮询/一次性查询均通过 Java 边界收口。
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from query.api.auth import require_internal_token
from query.api.errors import ApiError, not_found, validation_error
from query.api.service import QueryService, get_service
from query.api.structured import _display_score, make_normalizer
from query.contract import RouteType
from query.listing.r4_listing import array_any_expr

router = APIRouter(tags=["boundary"])

#: 边界 corpus_types → Milvus corpus_type 分区值(audit_project 未接入 → 422,见 ``_build_scope``)。
_CORPUS_MAP = {"internal": "P-INT", "external": "P-EXT", "qa": "P-QA", "case": "P-CASE"}
#: 查询热路径内部错误码(服务向)。
_ERR_INTERNAL = "B105"


class BoundaryFilters(BaseModel):
    """Java jCasbin 预计算过滤位(boundary.v1.yaml ``Filters``)。

    ``perm_tags`` 空数组=无额外限制(契约明文,非 fail-open);``owner``/``project_id`` 仅
    audit_project 语义,制度语料按契约忽略。``corpus_types`` 空没有可检分区 → 直接 422。
    """

    perm_tags: list[str]
    corpus_types: list[
        Literal["internal", "external", "qa", "case", "audit_project"]
    ] = Field(..., min_length=1)
    project_id: str | None = None
    owner: str | None = None


class BoundaryOptions(BaseModel):
    top_k: int | None = Field(default=None, ge=1)
    include_superseded: bool = False


class BoundaryQueryRequest(BaseModel):
    query: str = Field(..., min_length=1)
    request_id: str = Field(..., min_length=1)
    filters: BoundaryFilters
    options: BoundaryOptions = Field(default_factory=BoundaryOptions)


class BoundaryCaseDetailFilters(BaseModel):
    """Case detail stays behind the same Java-computed permission boundary."""

    perm_tags: list[str]


class BoundaryCaseDetailRequest(BaseModel):
    filters: BoundaryCaseDetailFilters


class BoundaryDmClauseDetailRequest(BaseModel):
    """Java 已授权 citation 的两个达梦回查键。"""

    source_doc_id: str = Field(..., min_length=1)


@router.post("/v1/query")
def query_boundary(
    body: BoundaryQueryRequest,
    _auth: None = Depends(require_internal_token),
    svc: QueryService = Depends(get_service),
):
    scope = _build_scope(body.filters, body.options)
    return _query_response(svc, body, scope)


@router.post("/v1/cases/{case_id}")
def case_detail_boundary(
    case_id: str,
    body: BoundaryCaseDetailRequest,
    _auth: None = Depends(require_internal_token),
    svc: QueryService = Depends(get_service),
) -> dict:
    detail = svc.case_detail(case_id, body.filters.perm_tags)
    if detail is None:
        # Missing and unauthorized are deliberately indistinguishable.
        raise not_found("案例不存在")
    return detail


@router.post("/v1/clauses/{clause_id}")
def clause_detail_boundary(
    clause_id: str,
    body: BoundaryCaseDetailRequest,
    _auth: None = Depends(require_internal_token),
    svc: QueryService = Depends(get_service),
) -> dict:
    """Returns authoritative clause text only inside Java's permission scope."""
    detail = svc.clause_detail(clause_id, body.filters.perm_tags)
    if detail is None:
        # Missing and unauthorized are deliberately indistinguishable.
        raise not_found("条款不存在")
    return detail


@router.post("/v1/dm/clauses/{source_code}")
def dm_clause_detail_boundary(
    source_code: str,
    body: BoundaryDmClauseDetailRequest,
    _auth: None = Depends(require_internal_token),
    svc: QueryService = Depends(get_service),
) -> dict:
    """按 citation 的 DM CODE 读取源库，不以 audit-ai PG 的 chunk_id 回查。"""
    detail = svc.dm_clause_detail(source_code, body.source_doc_id)
    if detail is None:
        # 和其他详情接口一致：不暴露源库中不存在的键。
        raise not_found("条款不存在")
    return detail


def _build_scope(filters: BoundaryFilters, options: BoundaryOptions) -> dict:
    """filters/options → ``Retriever.scoped`` 入参。校验失败抛 422(绝不静默放宽/静默零命中)。"""
    if "audit_project" in filters.corpus_types:
        # v1.6 Milvus schema 无 audit_project 分区、无 project_id/owner 标量:静默零命中会把
        # 集成/配置问题伪装成「未找到依据」,检索后过滤则破红线 → 显式拒绝,支持后一并放开。
        raise validation_error(
            "audit_project 语料未接入 audit-ai 当前 Milvus schema,暂不支持",
            {"corpus_types": list(filters.corpus_types)},
        )
    return {
        "corpora": tuple(_CORPUS_MAP[c] for c in filters.corpus_types),
        # 空 perm_tags = 无额外限制(契约);非空走 r4_listing 加固构造(白名单字段 + json 转义)
        "extra_expr": (
            array_any_expr("perm_tag", list(filters.perm_tags)) if filters.perm_tags else None
        ),
        "topk": options.top_k,
        "include_superseded": options.include_superseded,
    }


def _query_response(svc: QueryService, body: BoundaryQueryRequest, scope: dict) -> dict:
    """执行一次查询并返回完整 JSON；不在传输层暴露事件或流状态。"""
    try:
        started_at = time.perf_counter()
        collected: list = []
        # fail-closed:retriever 无 scoped 即异常，绝不无过滤放行(权限红线)
        with svc.retriever.scoped(collector=collected, **scope):
            result = svc.agent.ask(body.query, trace_id=body.request_id)

        # 浏览器结果 Tab 由同一查询和同一 Java 预计算权限范围生成。结构化装配需要
        # 独立检索，故单独开 scoped 上下文，避免干扰回答引用的候选分数收集。
        with svc.retriever.scoped(**scope):
            structured = svc.structured_for(
                body.query, include_superseded=body.options.include_superseded,
            )

        score_map = _score_map(collected)
        src_map = _source_map(collected)
        return {
            "meta": {
                "request_id": body.request_id,
                "route_type": result.route_type.value,
                "ai_label": result.ai_label,
                "review_required": result.review_required,
                "export_enabled": result.export_enabled,
                "elapsed_ms": int((time.perf_counter() - started_at) * 1000),
            },
            "answer_blocks": [{
                "block_seq": seq,
                "block_type": block.type.value,
                "content": block.content,
            } for seq, block in enumerate(result.answer_blocks)],
            "citations": [{
                # 轻量引用:clause_id(=chunk_id)+ score + DM 回查键(source_code/source_doc_id,
                # 取自本次检索候选=Milvus hit,不新增 PG 回查);Java 按 source_code 回查达梦四级引用。
                "clause_id": citation.clause_id,
                "chunk_id": citation.clause_id,
                "score": score_map.get(citation.clause_id),
                "source_code": src_map.get(citation.clause_id, {}).get("source_code"),
                "source_doc_id": src_map.get(citation.clause_id, {}).get("source_doc_id"),
            } for citation in result.citations],
            "structured": structured.to_dict(),
            "completion": {
                "finish_reason": "refused" if result.route_type is RouteType.REFUSE else "stop",
                "confidence": result.confidence,
                "exhausted_scope": list(result.exhausted_scope),
            },
        }
    except Exception as err:
        # 500 不泄内部细节；统一错误处理器渲染 JSON 错误体。
        raise ApiError(500, _ERR_INTERNAL, "生成失败") from err


def _source_map(candidates: list) -> dict[str, dict]:
    """候选(collector,Milvus hit 携带)→ ``chunk_id → {source_code, source_doc_id}``(DM 回查键)。

    取自本次检索候选(**不新增 PG 回查**);非 DM 源 / 超256弃锚 → ``None``,Java 侧当缺失回落。
    """
    out: dict[str, dict] = {}
    for c in candidates:
        out[c.chunk_id] = {
            "source_code": getattr(c, "source_code", None) or None,
            "source_doc_id": getattr(c, "source_doc_id", None) or None,
        }
    return out


def _score_map(candidates: list) -> dict[str, float]:
    """同一次检索的候选(collector)→ ``chunk_id → 归一分``。

    同 chunk 保最高分;min-max 与前端 structured「匹配度」同口径(``make_normalizer``)。
    引用不在集合内(极少数路由自建候选)→ ``score: null``(契约 nullable,biz 降级不显)。
    """
    by_id: dict[str, float] = {}
    for c in candidates:
        s = _display_score(c)  # 与前端 structured 同口径:rerank 开→相关性分,否则 RRF
        prev = by_id.get(c.chunk_id)
        if prev is None or s > prev:
            by_id[c.chunk_id] = s
    norm = make_normalizer(list(by_id.values()))
    return {cid: norm(s) for cid, s in by_id.items()}
