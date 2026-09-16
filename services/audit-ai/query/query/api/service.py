"""T4(SPEC-API §15):域装配。

``QueryService`` 持 ``QueryAgent``/``PgIO``/``SessionStore``/``Retriever``/qcfg,惰性 ``from_config``
(连真栈)或注入(测试)。路由经 ``get_service`` 依赖取它,只调域函数——不进 graph 节点。
"""

from __future__ import annotations

import os

from fastapi import Request


class QueryService:
    """API 域装配门面。共享一套 retriever/pg(问答 + 结构化装配 + 会话共用)。"""

    def __init__(self, *, agent, pg, store, retriever, qcfg, llm=None, merge_llm=None) -> None:
        self.agent = agent
        self.pg = pg
        self.store = store
        self.retriever = retriever
        self.qcfg = qcfg
        self.llm = llm            # 主答 LLM
        self.merge_llm = merge_llm  # N0 归并客户端(None → 规则版离线兜底)
        self.uploads: dict = {}   # upload_id → meta(只存不消费;附件引用校验用,SPEC-API §8.4)
        self._dm_source_dsn = None
        self._dm_source_engine = None

    def structured_for(self, query, *, include_superseded=False, corpus=None):
        """检索 + PG 回查 + 装配 → ``StructuredResult``(四-Tab)。

        与 ``agent.ask`` 各检索一次(PLAN 接受的双检索;确定性 → 同候选)。``corpus`` 限内规/外规。
        """
        from query.api.structured import assemble_structured, fetch_pg_context
        from query.retrieve.hybrid import drop_degraded

        cands = drop_degraded(
            self.retriever.retrieve(query, include_superseded=include_superseded)
        )
        cands = _filter_corpus(cands, corpus)
        case_cands = (
            drop_degraded(self.retriever.retrieve_cases(query))
            if getattr(self.qcfg, "attach_cases", False) else []
        )
        chunk_doc, case_rows = fetch_pg_context(self.pg, cands, case_cands)
        return assemble_structured(cands, case_cands, chunk_doc, case_rows)

    def clause_detail(self, clause_id, perm_tags=None):
        """条款回查(SPEC-API §8.3):四级锚点 + 全文 + 节级父块。不存在 → None。

        权威 PG(``anchors``/``chunks.text``,非 Milvus 截断);「查看原文/详细释义/完整定义」都打它。
        ``perm_tags`` 由 Java 边界传入；无权限和不存在均返回 ``None``，避免详情接口枚举
        受限条款。会话式旧接口不传该值，保持原有调用兼容。
        """
        from sqlalchemy import select

        from common.pg_models import Chunk, DocVersion
        from query.generate.anchors import fetch_anchors, fetch_parent_text

        with self.pg.session() as s:
            row = s.execute(
                select(Chunk, DocVersion)
                .join(DocVersion, DocVersion.doc_version_id == Chunk.doc_version_id)
                .where(Chunk.chunk_id == clause_id)
            ).one_or_none()
            if row is None:
                return None
            chunk, version = row
            if perm_tags and version.perm_tag not in perm_tags:
                return None
            text = chunk.text

        cit = fetch_anchors(self.pg, [clause_id]).get(clause_id)
        if cit is None:
            return None
        detail = cit.to_dict()
        # ``full_text`` is the browser boundary field. Keep ``text`` for the
        # existing session endpoint and other legacy callers.
        detail["full_text"] = text
        detail["text"] = text
        detail["parent_text"] = fetch_parent_text(self.pg, clause_id)
        return detail

    def case_detail(self, case_id, perm_tags):
        """案例回查：按 doc_version_id 读取 PG 权威要素与完整块文本。

        `perm_tags` 由 Java 预计算；无权限和不存在均返回 ``None``，避免通过详情接口枚举受限案例。
        """
        from sqlalchemy import select

        from common.pg_models import Case, Chunk, DocVersion

        with self.pg.session() as s:
            row = s.execute(
                select(Case, DocVersion)
                .join(DocVersion, DocVersion.doc_version_id == Case.doc_version_id)
                .where(Case.doc_version_id == case_id)
            ).one_or_none()
            if row is None:
                return None
            case, version = row
            if perm_tags and version.perm_tag not in perm_tags:
                return None
            chunks = s.execute(
                select(Chunk.text)
                .where(Chunk.doc_version_id == case_id)
                .order_by(Chunk.seq, Chunk.chunk_id)
            ).scalars().all()

        return {
            "case_id": case_id,
            "case_name": version.title,
            "regulator": case.penalty_org,
            "penalty_date": _iso_date(case.penalty_date),
            "violation_topic": case.violation_category,
            "related_regulation": _related_regulations_text(case.cited_regulations),
            "core_issue": case.penalty_type,
            "insight": None,
            "full_text": "\n\n".join(text for text in chunks if text),
            "source_url": case.source_url,
        }

    def dm_clause_detail(self, source_code, source_doc_id):
        """按达梦 ``LAW_CONTENT.CODE`` + ``LAW_BASIC.CODE`` 读取法规全文。

        该边界只接收 Java 在已授权检索结果中缓存的两个 source key。它刻意不读取
        audit-ai 的业务 PG：真达梦与本地 PG 仿真均使用 ``PRESEG_SOURCE_DSN``，方言由
        SQLAlchemy 驱动决定。
        """
        from sqlalchemy import create_engine, text

        dsn = os.environ.get("PRESEG_SOURCE_DSN")
        if not dsn:
            raise RuntimeError("PRESEG_SOURCE_DSN is required for DM clause detail lookup")
        if self._dm_source_engine is None or self._dm_source_dsn != dsn:
            self._dm_source_engine = create_engine(dsn, pool_pre_ping=True)
            self._dm_source_dsn = dsn

        # 不使用 LIMIT/ROWNUM：源端 DM8 与 PG 仿真都能执行。源表没有主键，真库可能
        # 存在内容重复行，因此以既有导出路径相同的稳定顺序取首行。
        sql = text("""
            SELECT
                b.CODE AS source_doc_id,
                b.NAME AS doc_title,
                b.DOC_NO AS doc_number,
                b.ISSUE_AUTH_CN AS issuer,
                b.STATUS_CODE AS status_code,
                b.EFFECT_DATE AS effective_date,
                c.CODE AS source_code,
                c.TITLE AS clause_title,
                c.PATH_CODE AS clause_path,
                c.CONTENT AS full_text
            FROM ZNFG_IAM_LAW_CONTENT c
            JOIN ZNFG_IAM_LAW_BASIC b ON b.CODE = c.LAW_CODE
            WHERE c.CODE = :source_code
              AND c.LAW_CODE = :source_doc_id
              AND (c.DEL_FLAG IS NULL OR c.DEL_FLAG <> 'D')
              AND (b.DEL_FLAG IS NULL OR b.DEL_FLAG <> 'D')
            ORDER BY c.INDEX_NO, c.CODE, c.ID
        """)
        with self._dm_source_engine.connect() as conn:
            row = conn.execute(sql, {
                "source_code": source_code,
                "source_doc_id": source_doc_id,
            }).mappings().first()
            if row is not None:
                row = _source_row(row)
            full_text = _source_text(row.get("full_text")) if row is not None else ""
            if row is not None and not full_text:
                # 真实达梦的有效 LAW_CONTENT 行几乎都不存正文；正文被拆到详情表。
                # 只在主表正文缺失时回退，保证旧源/本地仿真的主表正文仍是权威优先级。
                details_sql = text("""
                    SELECT CONTENT_ORDER AS content_order, ID AS row_id, CONTENT AS content
                    FROM ZNFG_IAM_LAW_CONTENT_DETAIL
                    WHERE LAW_CONTENT_CODE = :source_code
                      AND LAW_CODE = :source_doc_id
                      AND CONTENT_TYPE = 0
                      AND (DEL_FLAG IS NULL OR DEL_FLAG <> 'D')
                    ORDER BY CONTENT_ORDER, ID
                """)
                details = conn.execute(details_sql, {
                    "source_code": source_code,
                    "source_doc_id": source_doc_id,
                }).mappings().all()
                full_text = _source_detail_text(details)
        if row is None:
            return None

        return {
            "clause_id": row["source_code"],
            "source_code": row["source_code"],
            "source_doc_id": row["source_doc_id"],
            "doc_title": row["doc_title"],
            "doc_number": row["doc_number"],
            "issuer": row["issuer"],
            "status_code": row["status_code"],
            "effective_date": _iso_date(row["effective_date"]),
            "clause_title": row["clause_title"],
            "clause_path": row["clause_path"],
            "full_text": full_text,
            "text": full_text,
        }

    @classmethod
    def from_config(cls) -> QueryService:
        """连真栈(生产):惰性建;共享 retriever/pg 给 QueryAgent(不重复建)。"""
        from pipeline.config import load_config
        from pipeline.index.pg_io import PgIO
        from query.config import load_query_config
        from query.graph import QueryAgent
        from query.llm import make_llm_client, maybe_make_llm_client
        from query.observe import make_tracer
        from query.retrieve.hybrid import Retriever
        from query.session.store import SessionStore

        qcfg = load_query_config()
        pg = PgIO.from_config(load_config())
        tracer = make_tracer(qcfg)
        retriever = Retriever.from_config(qcfg, tracer=tracer)
        llm = make_llm_client(qcfg)
        # N0 归并客户端(与 QueryAgent._merge_llm 同构);stub/无 key → None 规则版
        merge_llm = maybe_make_llm_client(
            qcfg.merge_context, qcfg, model=qcfg.merge_model or qcfg.llm_model
        )
        agent = QueryAgent(retriever, pg, llm, qcfg, tracer=tracer)
        return cls(
            agent=agent, pg=pg, store=SessionStore(pg), retriever=retriever, qcfg=qcfg,
            llm=llm, merge_llm=merge_llm,
        )


_CORPUS_MAP = {"internal": "P-INT", "external": "P-EXT"}


def _filter_corpus(cands, corpus):
    """按 corpus 限定候选(internal→P-INT / external→P-EXT);None → 全留。"""
    if not corpus:
        return cands
    ct = _CORPUS_MAP[corpus]
    return [c for c in cands if c.corpus_type == ct]


def _iso_date(value):
    return value.isoformat() if value is not None else None


def _related_regulations_text(value):
    if not value:
        return None
    if isinstance(value, list):
        return "；".join(str(item) for item in value if item)
    return str(value)


def _source_row(row):
    """源库驱动的映射键不是契约：达梦常返回大写、PG 仿真返回小写。"""
    return {str(key).lower(): value for key, value in row.items()}


def _source_text(value) -> str:
    return str(value).strip() if value is not None else ""


def _source_detail_text(rows) -> str:
    """按详情顺序拼接正文；同一顺序的不同文本视为源数据冲突，拒绝猜测。"""
    segments = []
    for raw in rows:
        row = _source_row(raw)
        text = _source_text(row.get("content"))
        if not text:
            continue
        try:
            order = int(row.get("content_order"))
        except (TypeError, ValueError):
            order = 0
        segments.append((order, str(row.get("row_id") or ""), text))

    by_order = {}
    merged = []
    for order, _row_id, text in sorted(segments):
        prior = by_order.get(order)
        if prior is not None:
            if prior != text:
                raise RuntimeError(f"LAW_CONTENT_DETAIL conflicting text order: {order}")
            continue
        by_order[order] = text
        merged.append(text)
    return "\n".join(merged)


def get_service(request: Request) -> QueryService:
    """FastAPI 依赖:取(或惰性建)``QueryService``。测试注入 fake 时直接返回。"""
    svc = getattr(request.app.state, "service", None)
    if svc is None:
        svc = QueryService.from_config()
        request.app.state.service = svc
    return svc
