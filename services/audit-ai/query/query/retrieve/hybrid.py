"""R1 混合检索:查询向量化 → milvus_io 混合检索(内规∥外规分区配额)→ 合并取 topk。

复用 ``pipeline.index``:``embedding_client``(查询 dense+sparse 一次产出)+ ``milvus_io``
(hybrid + RRFRanker + ``status==effective`` **前置过滤**,hybrid 失败 dense-only 兜底)。

§5.2 分区配额:内规(P-INT)/外规(P-EXT)**各打各的** ``partition_topk``,合并取 ``topk``——避免
外规 20x 体量淹没内规。§5.3 过滤位:status(milvus_io 内置 effective 前置)+ perm_tag(M1 预留不
过滤,与摄取侧一致)。entity_type/biz_domain 条件过滤本切片**暂缓**(``milvus_io.search`` 未暴露
附加 expr、hit 不带该字段);升级路径:pipeline 侧给 search 加附加 expr / output_fields(另议)。
"""

from __future__ import annotations

import contextvars
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass, replace

from pipeline.config import load_config
from pipeline.index.embedding_client import EmbeddingClient
from pipeline.index.milvus_io import MilvusIO
from query.config import QueryConfig, load_query_config
from query.llm import maybe_make_llm_client
from query.retrieve.decompose import decompose_subqueries
from query.retrieve.hyde import hyde_dense_text
from query.retrieve.sparse_boost import augment_sparse, load_scenario_terms

#: 检索分区(§5.2):内规 / 外规各打各的配额
_PARTITIONS = ("P-INT", "P-EXT")
#: 主检索(R1/R5)可打的分区全集:边界 scope 含 qa 时加打 P-QA;P-CASE 走 ``retrieve_cases``。
_MAIN_CORPORA = ("P-INT", "P-EXT", "P-QA")


@dataclass(frozen=True)
class RetrievalScope:
    """边界层注入的检索前置过滤(boundary.v1.yaml:值由 Java 预计算,本层只作 Milvus filter 消费)。

    ``collector`` 是调用方提供的候选收集槽:``retrieve*`` 把**实际返回**的候选 append 进去,
    供边界层在同一次检索上派生 per-hit 分数(免二次检索、免候选集漂移)。
    """

    corpora: tuple[str, ...] | None = None
    extra_expr: str | None = None
    topk: int | None = None
    partition_topk: int | None = None
    include_superseded: bool | None = None
    collector: list | None = None


_SCOPE: contextvars.ContextVar[RetrievalScope | None] = contextvars.ContextVar(
    "query_retrieval_scope", default=None
)


def _and_expr(left: str | None, right: str | None) -> str | None:
    """两个 Milvus expr 合取;任一为空取另一个,双空 → None。"""
    if left and right:
        return f"{left} and {right}"
    return left or right


def _corpora_for(
    scope: RetrievalScope | None, default: tuple[str, ...], allowed: tuple[str, ...]
) -> tuple[str, ...]:
    """分区路由单点规则(改语义只改这一处):scope 未设 → ``default``(既有行为 byte 等价);
    已设 → 与 ``allowed`` 求交。``allowed`` = 该检索路支持的分区全集——主检索 ``_MAIN_CORPORA``
    (qa scope 才加打 P-QA)、枚举 ``_PARTITIONS``(条款树列举仅内/外规,qa/case scope 下枚举
    为空 → 上层覆盖拒答,**刻意语义**)、案例 ``("P-CASE",)``(scope 不含 case → 整路跳过)。
    """
    if scope is None or scope.corpora is None:
        return default
    return tuple(c for c in allowed if c in scope.corpora)


def _scope_superseded(scope: RetrievalScope | None, include_superseded: bool) -> bool:
    """scope 显式设定 ``include_superseded`` 时覆盖调用方缺省(边界契约位对**答案路径**生效)。"""
    if scope is not None and scope.include_superseded is not None:
        return scope.include_superseded
    return include_superseded


def scope_active() -> bool:
    """当前是否处于边界前置过滤 scope 内(边界二请求期为真;前端/CLI 为假)。

    用于关掉**按 PG 身份精确取数、绕过 Milvus 前置过滤**的 widening 桥接(案例精确反查 /
    R5 引用条款解析):前置过滤边界下按身份取的内容无法证明在 Java 授权集内,不得越界。
    经 scope 的检索路(``retrieve*``)本身已带 corpus 门 + perm_tag,故不受此影响。
    """
    return _SCOPE.get() is not None


def _collect(scope: RetrievalScope | None, cands: list[Candidate]) -> None:
    """把本路实际返回的候选写进收集槽(scope 未设/未带槽 → no-op,零开销)。"""
    if scope is not None and scope.collector is not None:
        scope.collector.extend(cands)


def _build_hyde_llm(qcfg: QueryConfig):
    """§3.1 N1 HyDE dense 改写客户端(仅 hyde 开+gateway+有 key);否则 None → 原问 dense no-op。"""
    return maybe_make_llm_client(qcfg.hyde, qcfg, model=qcfg.hyde_model or qcfg.llm_model)


def _build_decompose_llm(qcfg: QueryConfig):
    """§3.3 N3 分解客户端(仅 decompose 开+gateway+有 key);否则 None → 单查询 [query] 直通。"""
    return maybe_make_llm_client(
        qcfg.decompose, qcfg, model=qcfg.decompose_model or qcfg.llm_model
    )


@dataclass(frozen=True)
class Candidate:
    """检索候选(带 clause_id + 四级引用粗字段;精确锚点由 generate/anchors 回查 PG)。"""

    chunk_id: str
    score: float
    corpus_type: str | None
    doc_version_id: str | None
    clause_path: str | None
    page_start: int | None
    degraded: bool
    retrieval_mode: str  # hybrid | dense_only(命中所在分区的检索模式)
    text: str | None = None  # §5.5 Milvus 截断 text(仅 with_text 检索-重排一跳填;默认 None)
    rerank_score: float | None = None  # 重排器相关性绝对分(仅 rerank 开时填;RRF 融合分见 score)
    source_code: str | None = None  # DM LAW_CONTENT.CODE(Java 回查达梦键;非 DM 源/弃锚为空)
    source_doc_id: str | None = None  # DM LAW_BASIC.CODE(文档级)


@dataclass(frozen=True)
class BatchRetrievalResult:
    """一条上传条款的内规候选；单条失败不影响同批其他条款。"""

    query: str
    candidates: list[Candidate]
    error: str | None = None


def _to_candidate(hit: dict, mode: str) -> Candidate:
    return Candidate(
        chunk_id=hit["chunk_id"],
        score=float(hit.get("score", 0.0)),
        corpus_type=hit.get("corpus_type"),
        doc_version_id=hit.get("doc_version_id"),
        clause_path=hit.get("clause_path"),
        page_start=hit.get("page_start"),
        degraded=bool(hit.get("degraded")),
        retrieval_mode=mode,
        text=hit.get("text"),  # with_text=False 时 None(rerank=none 路径无开销)
        source_code=hit.get("source_code"),  # DM 回查键(Milvus hit 携带;CP-010)
        source_doc_id=hit.get("source_doc_id"),
    )


def drop_degraded(candidates: list[Candidate]) -> list[Candidate]:
    """剔除 degraded 候选——契约:degraded 块仅全文检索、不参与条款级引用(CLAUDE.md)。"""
    return [c for c in candidates if not c.degraded]


class Retriever:
    """混合检索器:持有查询嵌入 + Milvus 客户端(连真栈)。"""

    def __init__(
        self, embed: EmbeddingClient, milvus: MilvusIO, qcfg: QueryConfig, reranker=None,
        hyde_llm=None, decompose_llm=None, tracer=None,
    ) -> None:
        from query.observe import NoopTracer  # 局部导入,避 import 期环
        from query.rerank.reranker import make_reranker  # 局部导入,避 import 期环

        self._embed = embed
        self._milvus = milvus
        self._qcfg = qcfg
        # rerank_backend=none → NoneReranker(passthrough,byte 等价);bge → 本地 reranker
        self._reranker = reranker if reranker is not None else make_reranker(qcfg)
        # §5.4 词典扩展种子(consumed-when-present;scenario_expand 关 → {} 免 IO)
        self._scenario_terms = (
            load_scenario_terms(qcfg.scenario_terms_path) if qcfg.scenario_expand else {}
        )
        # §3.1 N1 HyDE dense 改写客户端(仅 hyde 开+gateway;否则 None → 原问 dense,byte 等价)
        self._hyde_llm = hyde_llm
        # §3.3 N3 问题分解客户端(仅 decompose 开+gateway;否则 None → 单查询 [query],byte 等价)
        self._decompose_llm = decompose_llm
        # §9.3 观测 tracer(只读旁路):默认 NoopTracer 零开销;发 HyDE/子查询 event 到当前 trace
        self._tracer = tracer or NoopTracer()

    @contextmanager
    def scoped(
        self,
        *,
        corpora: tuple[str, ...] | None = None,
        extra_expr: str | None = None,
        topk: int | None = None,
        partition_topk: int | None = None,
        include_superseded: bool | None = None,
        collector: list | None = None,
    ):
        """请求内给所有 ``retrieve*`` 加 Milvus 前置过滤(contextvar 并发隔离,退出必复位)。

        边界二(routes_boundary)入口:检索**前**生效(红线:算在 Java、用在 Python)。
        ``collector`` 收集本请求实际返回的候选,供上层免二次检索派生分数。
        """
        token = _SCOPE.set(RetrievalScope(
            corpora=corpora, extra_expr=extra_expr, topk=topk, partition_topk=partition_topk,
            include_superseded=include_superseded, collector=collector,
        ))
        try:
            yield
        finally:
            _SCOPE.reset(token)

    @classmethod
    def from_config(cls, qcfg: QueryConfig | None = None, *, tracer=None) -> Retriever:
        """连真栈:复用 pipeline embedding/milvus。``tracer`` 由 QueryAgent 注入(§9.3 观测)。"""
        qcfg = qcfg or load_query_config()
        settings = load_config()
        milvus = MilvusIO(settings)
        milvus.connect()
        return cls(
            EmbeddingClient.from_config(settings), milvus, qcfg,
            hyde_llm=_build_hyde_llm(qcfg), decompose_llm=_build_decompose_llm(qcfg),
            tracer=tracer,
        )

    def retrieve(self, query: str, *, include_superseded: bool = False) -> list[Candidate]:
        """§3.3 N3 分解 fan-out:子查询各检索 → 候选并集 → §5.5 重排(原问)→ 取 topk。

        ``_subqueries_for`` 默认 ``[query]``(关/stub)→ 单查询、与既有 byte 等价;仅复合问句
        (decompose 拆 >1)才 fan-out。综合 = 候选并集(保最高分,覆盖各子约束),生成层零改。
        """
        scope = _SCOPE.get()
        include_superseded = _scope_superseded(scope, include_superseded)
        merged: dict[str, Candidate] = {}
        for subquery in self._subqueries_for(query):
            for cid, cand in self._search_candidates(
                subquery,
                include_superseded=include_superseded,
                corpora=_corpora_for(scope, _PARTITIONS, _MAIN_CORPORA),
                extra_expr=scope.extra_expr if scope else None,
                partition_topk=scope.partition_topk if scope else None,
            ).items():
                prev = merged.get(cid)
                if prev is None or cand.score > prev.score:
                    merged[cid] = cand
        ranked = sorted(merged.values(), key=lambda c: c.score, reverse=True)  # RRF 序(none 终态)
        # 重排对**原问**(none passthrough,byte 等价);写回相关性绝对分 rerank_score(none→None),
        # 供 §8.1 匹配度下限过滤(设计 A;rerank 关无绝对分 → no-op,见 sufficiency.above_min_score)
        ranked = [
            replace(c, rerank_score=s) if s is not None else c
            for c, s in self._reranker.rerank_scored(query, ranked)
        ]
        out = ranked[: (scope.topk if scope and scope.topk else self._qcfg.topk)]
        _collect(scope, out)
        return out

    def retrieve_batch(
        self,
        queries: list[str],
        *,
        max_concurrency: int | None = None,
        include_superseded: bool = False,
        corpora: tuple[str, ...] = ("P-INT",),
    ) -> list[BatchRetrievalResult]:
        """上传外规的多个条款并行检索，结果严格与输入条款同序。

        嵌入模型只在调用线程中做一次批量编码，避免本地 BGE-M3 并发推理争抢内存；随后仅将
        Milvus 检索放入有界线程池。重排仍在调用线程串行执行，避免非线程安全的重排模型被并发
        调用。任一条款检索失败仅在该条结果标记 ``error``，整批继续返回。
        """
        if not queries:
            return []
        workers = (
            self._qcfg.batch_retrieve_concurrency
            if max_concurrency is None
            else max_concurrency
        )
        if workers < 1:
            raise ValueError("max_concurrency 必须大于 0")

        scope = _SCOPE.get()
        include_superseded = _scope_superseded(scope, include_superseded)
        common = {
            "include_superseded": include_superseded,
            # 调用方显式指定候选语料分区。默认保持既有的外规→内规覆盖核查行为；
            # 内规→外规则以 P-EXT 调用这一同一批量路径。
            "corpora": _corpora_for(scope, corpora, corpora),
            "extra_expr": scope.extra_expr if scope else None,
            "partition_topk": scope.partition_topk if scope else None,
        }
        results: list[BatchRetrievalResult | None] = [None] * len(queries)
        prepared = self._prepare_batch_embeddings(queries, results)

        with ThreadPoolExecutor(max_workers=min(workers, len(queries))) as executor:
            futures = {
                executor.submit(
                    self._search_candidates_from_vectors, query, dense, sparse, **common
                ): index
                for index, (query, dense, sparse) in prepared.items()
            }
            for future in as_completed(futures):
                index = futures[future]
                try:
                    ranked = sorted(future.result().values(), key=lambda c: c.score, reverse=True)
                    ranked = [
                        replace(c, rerank_score=score) if score is not None else c
                        for c, score in self._reranker.rerank_scored(queries[index], ranked)
                    ]
                    topk = scope.topk if scope and scope.topk else self._qcfg.topk
                    results[index] = BatchRetrievalResult(queries[index], ranked[:topk])
                except Exception:
                    results[index] = BatchRetrievalResult(queries[index], [], "检索失败")

        out = [row for row in results if row is not None]
        for row in out:
            _collect(scope, row.candidates)
        return out

    def _prepare_batch_embeddings(
        self, queries: list[str], results: list[BatchRetrievalResult | None]
    ) -> dict[int, tuple[str, list[float], dict]]:
        """批量编码优先；若整批编码失败，按条回退以隔离坏条款。"""
        try:
            embeddings = self._embed.embed(queries)
            if len(embeddings) != len(queries):
                raise ValueError("嵌入结果数量不匹配")
        except Exception:
            embeddings = []
            for index, query in enumerate(queries):
                try:
                    embeddings.append(self._embed.embed([query])[0])
                except Exception:
                    results[index] = BatchRetrievalResult(query, [], "嵌入失败")
                    embeddings.append(None)

        prepared: dict[int, tuple[str, list[float], dict]] = {}
        for index, (query, emb) in enumerate(zip(queries, embeddings, strict=True)):
            if emb is None:
                continue
            try:
                prepared[index] = (query, emb.dense, self._sparse_for(query, emb))
            except Exception:
                results[index] = BatchRetrievalResult(query, [], "嵌入失败")
        return prepared

    def _subqueries_for(self, query: str) -> list[str]:
        """§3.3 N3:decompose 开+gateway → 复合问句拆子查询;否则/单跳/失败 → ``[query]``(直通)。"""
        if self._decompose_llm is None:
            return [query]
        subs = decompose_subqueries(
            query, self._decompose_llm, max_sub=self._qcfg.decompose_max_sub
        )
        if len(subs) > 1:  # §9.3 观测:复合拆分进 trace(只读旁路;单查询不发)
            self._tracer.event("decompose", subqueries=subs)
        return subs

    def _search_candidates(
        self,
        query: str,
        *,
        include_superseded: bool = False,
        corpora: tuple[str, ...] = _PARTITIONS,
        extra_expr: str | None = None,
        partition_topk: int | None = None,
    ) -> dict[str, Candidate]:
        """单子查询分区配额检索 → 合并去重(含 §3.1 HyDE / §5.4 sparse)。返回 chunk_id→候选。

        ``corpora``/``extra_expr``/``partition_topk`` 由 ``retrieve`` 从 scope 解出;缺省与既有
        行为 byte 等价(``extra_expr=None`` 即 ``milvus_io.search`` 自身缺省)。
        """
        with_text = self._qcfg.rerank_backend != "none"  # 仅重排时取 Milvus text(零开销默认)
        emb = self._embed.embed([query])[0]
        dense = self._dense_for(query, emb)    # §3.1 HyDE(关/stub → emb.dense,byte 等价)
        sparse = self._sparse_for(query, emb)  # §5.4 提权/扩展(双关关 → emb.sparse,byte 等价)
        return self._search_candidates_from_vectors(
            query, dense, sparse,
            include_superseded=include_superseded,
            corpora=corpora,
            extra_expr=extra_expr,
            partition_topk=partition_topk,
            with_text=with_text,
        )

    def _search_candidates_from_vectors(
        self,
        query: str,
        dense: list[float],
        sparse: dict,
        *,
        include_superseded: bool = False,
        corpora: tuple[str, ...] = _PARTITIONS,
        extra_expr: str | None = None,
        partition_topk: int | None = None,
        with_text: bool | None = None,
    ) -> dict[str, Candidate]:
        """已完成嵌入的单条查询执行分区检索；供常规/批量检索共用。"""
        if with_text is None:
            with_text = self._qcfg.rerank_backend != "none"
        found: dict[str, Candidate] = {}
        for corpus in corpora:
            res = self._milvus.search(
                dense,
                sparse,
                topk=partition_topk or self._qcfg.partition_topk,
                include_superseded=include_superseded,
                corpus=corpus,
                extra_expr=extra_expr,
                with_text=with_text,
                query_text=query,  # CP-012:bm25 走 query 原文;bge 忽略(byte 等价)
            )
            for hit in res.hits:
                cand = _to_candidate(hit, res.retrieval_mode)
                prev = found.get(cand.chunk_id)
                if prev is None or cand.score > prev.score:
                    found[cand.chunk_id] = cand
        return found

    def _dense_for(self, query: str, emb):
        """§3.1 N1 HyDE:hyde 开+gateway → embed(原问+假设性法言)作 dense;否则/失败 → ``emb.dense``。

        ``hyde_llm`` None(关/stub)→ 原问 dense(byte 等价、零网络)。生成失败/返空 → 回落原问
        dense(N1-fail,绝不阻断)。**只改 dense**,sparse 仍走 ``_sparse_for``(§5.4)。
        """
        if self._hyde_llm is None:
            return emb.dense
        text = hyde_dense_text(query, self._hyde_llm)
        if not text:
            return emb.dense
        self._tracer.event("hyde", passage=text)  # §9.3 观测:HyDE 文本进 trace(只读旁路)
        return self._embed.embed([text])[0].dense

    def _sparse_for(self, query: str, emb) -> dict:
        """§5.4 提权/扩展。双关关 → ``emb.sparse`` 原样(byte 等价 + 只动 sparse)。"""
        if not (self._qcfg.docnum_boost or self._qcfg.scenario_expand):
            return emb.sparse
        return augment_sparse(
            query,
            emb.sparse,
            embed=self._embed,
            scenario_terms=self._scenario_terms,
            docnum_factor=self._qcfg.docnum_boost_factor,
            expand_factor=self._qcfg.scenario_expand_factor,
            docnum_on=self._qcfg.docnum_boost,
            expand_on=self._qcfg.scenario_expand,
        )

    def retrieve_enumerate(
        self, query: str, *, extra_expr: str | None = None, include_superseded: bool = False
    ) -> list[Candidate]:
        """§6.4 枚举模式:**高 k**(``enumerate_partition_topk``/``enumerate_topk``)+ 标量预过滤
        (``extra_expr`` 由 ``listing.build_milvus_expr`` 构,白名单字段)。不激进截断、不改 R1。
        分区配额合并去重(同 chunk_id 保高分)→ 按分降序取 ``enumerate_topk``。
        """
        scope = _SCOPE.get()
        include_superseded = _scope_superseded(scope, include_superseded)
        extra_expr = _and_expr(scope.extra_expr if scope else None, extra_expr)
        emb = self._embed.embed([query])[0]
        merged: dict[str, Candidate] = {}
        for corpus in _corpora_for(scope, _PARTITIONS, _PARTITIONS):
            res = self._milvus.search(
                emb.dense,
                emb.sparse,
                topk=self._qcfg.enumerate_partition_topk,
                include_superseded=include_superseded,
                corpus=corpus,
                extra_expr=extra_expr,
                query_text=query,  # CP-012:bm25 走 query 原文;bge 忽略(byte 等价)
            )
            for hit in res.hits:
                cand = _to_candidate(hit, res.retrieval_mode)
                prev = merged.get(cand.chunk_id)
                if prev is None or cand.score > prev.score:
                    merged[cand.chunk_id] = cand
        ranked = sorted(merged.values(), key=lambda c: c.score, reverse=True)
        out = ranked[: self._qcfg.enumerate_topk]
        _collect(scope, out)
        return out

    def retrieve_cases(self, query: str, *, include_superseded: bool = False) -> list[Candidate]:
        """§6.3 案例分区(P-CASE)语义检索 → 按分降序的 chunk 级候选(``partition_topk`` 条)。

        一案多 chunk(case_summary + case_section)由上层按 ``doc_version_id`` 去重为"一案一卡";
        故此处**不截 topk、不按 dvid 去重**,留足头部供上层去重后仍有足够 distinct 案例。
        ``status==effective`` 前置 + degraded 由上层 ``drop_degraded`` 剔除(沿用 R1 契约)。
        """
        scope = _SCOPE.get()
        if not _corpora_for(scope, ("P-CASE",), ("P-CASE",)):
            return []  # scope 不含 case → 整路跳过(前置过滤,非检索后丢弃)
        include_superseded = _scope_superseded(scope, include_superseded)
        emb = self._embed.embed([query])[0]
        res = self._milvus.search(
            emb.dense,
            emb.sparse,
            topk=self._qcfg.partition_topk,
            include_superseded=include_superseded,
            corpus="P-CASE",
            extra_expr=scope.extra_expr if scope else None,
            query_text=query,  # CP-012:bm25 走 query 原文;bge 忽略(byte 等价)
        )
        cands = [_to_candidate(hit, res.retrieval_mode) for hit in res.hits]
        out = sorted(cands, key=lambda c: c.score, reverse=True)
        _collect(scope, out)
        return out
