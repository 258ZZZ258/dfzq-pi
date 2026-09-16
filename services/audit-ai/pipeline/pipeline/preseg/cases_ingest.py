"""案例结构化直装——虚拟文档合成部分(CP-010 T5,决策 D4;完整直装链 T9)。

源案例是「结构化记录 + 附件」,不天然对应一份决定书文件。每案合成一个 doc_version
(``source_format="preseg"``,raw = 案例记录 JSON 原文,溯源即源记录),cases→doc_versions
外键不动 → bridge/r5 消费链零改。**corpus_type=P-CASE**(检索分区归属,见 reader 口径钉子)。

幂等键:``source_case_id + record_hash``(reader 计算的记录规范化哈希);源主键缺失时退
record_hash 单键。同键重跑 → DUPLICATE 不新建;同 source_case_id 换 hash → 新版本自动
version chain(revise_replace 继承 logical)。
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict

from sqlalchemy import select
from ulid import ULID

from common.pg_models import Document, DocVersion, PipelineEvent
from pipeline.preseg.reader import PresegCase
from pipeline.stage_base import StageContext
from pipeline.states import PipelineState

logger = logging.getLogger(__name__)


def find_existing_case_doc(ctx: StageContext, case: PresegCase) -> DocVersion | None:
    """幂等命中:同 source_case_id+record_hash(或无源主键时同 record_hash 的 preseg 件)。"""
    with ctx.db.session() as s:
        q = select(DocVersion).where(DocVersion.content_hash == case.record_hash)
        if case.source_case_id:
            q = q.where(DocVersion.source_doc_id == case.source_case_id)
        else:
            q = q.where(DocVersion.source_format == "preseg")
        return s.scalars(q).first()


def _prior_case_doc(ctx: StageContext, case: PresegCase) -> DocVersion | None:
    """同源主键的既有版本(换 hash 场景)→ 自动 revise_replace 链目标。"""
    if not case.source_case_id:
        return None
    with ctx.db.session() as s:
        return s.scalars(
            select(DocVersion)
            .where(DocVersion.source_doc_id == case.source_case_id)
            .order_by(DocVersion.created_at.desc())
        ).first()


def synthesize_case_doc(
    ctx: StageContext, batch_id: str, case: PresegCase
) -> tuple[str, str]:
    """一条案例记录 → 虚拟 Document + DocVersion(REGISTERED)。返回 (dvid, logical_id)。

    调用方须先用 ``find_existing_case_doc`` 去重;本函数只管建。chunk 构建与 cases 表
    直装在 T9(cases_ingest 完整链),此处仅落文档骨架 + raw 溯源 + 事件。
    """
    raw = json.dumps(asdict(case), ensure_ascii=False, sort_keys=True).encode("utf-8")
    dvid = str(ULID())
    raw_key = ctx.object_store.put_raw("P-CASE", batch_id, dvid, "json", raw)

    prior = _prior_case_doc(ctx, case)
    logical_id = prior.logical_id if prior is not None else str(ULID())
    with ctx.db.session() as s:
        if prior is None:
            s.add(Document(logical_id=logical_id, corpus_type="P-CASE", title=case.case_name))
            s.flush()
        s.add(
            DocVersion(
                doc_version_id=dvid,
                logical_id=logical_id,
                batch_id=batch_id,
                source_format="preseg",  # 虚拟文档标识(D4;通道性标志,非文件格式)
                source_hash=case.record_hash,
                raw_object_key=raw_key,
                source_filename=None,
                pipeline_status=PipelineState.REGISTERED.value,
                perm_tag="internal",  # 案例库默认密级;真值域待样例(P1)
                title=case.case_name,
                doc_number=case.doc_number,
                issue_date=_iso_date(case.issue_date),
                source_doc_id=case.source_case_id,
                content_hash=case.record_hash,
                tags=case.tags or None,
                version_relation="revise_replace" if prior is not None else None,
                supersedes_version_id=prior.doc_version_id if prior is not None else None,
            )
        )
        s.flush()
        s.add(
            PipelineEvent(
                doc_version_id=dvid,
                from_state=None,
                to_state=PipelineState.REGISTERED.value,
                actor=ctx.user,
                detail={"preseg_case": {"source_case_id": case.source_case_id}},
            )
        )
    return dvid, logical_id


def _iso_date(value: str | None):
    from datetime import date

    # 非 str(reader 已拦;此为纵深:防 date.fromisoformat 收到非 str 抛未捕获 TypeError)
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


# ── T9:结构化直装完整链(替代 L1 正则案例抽取;case_l2 LLM 通道已整段移除)──────────────


def use_structured_case(dv, profiles: dict) -> bool:
    """分派条件(B8 配置缝):preseg 案例且 P-PRESEG 档案 case_ref_source=='structured'。

    非 'structured' 值 → 退回自建通道规则抽取(``s4_meta._extract_case``,零 LLM;case_l2 已移除)。
    """
    prof = profiles.get("P-PRESEG")
    return (
        dv is not None
        and dv.source_format == "preseg"
        and prof is not None
        and getattr(prof, "case_ref_source", "rule") == "structured"
    )


def reconcile_preseg_case_refs(ctx: StageContext, batch_id: str) -> int:
    """批末对账:把**本批** preseg 案例里"有源锚、但锚在案例 S4 当下尚未建块"的 fuzzy 引用
    **定点升级 exact**(同批竞态确定性自愈)。

    精确桥接在案例 S4 当下查 chunks,但 ``_structuring`` 在**同一步**内跑 S3(建 chunk)+ S4,且
    ``docs_in_states`` **无 ORDER BY**——同轮内案例 S4 可能先于被引法规 S3 执行,当场落 fuzzy。批
    驱动 drain 后本批法规**必已建块**,重解析即升级 exact,**与扫描顺序无关**(替代已删的全局对账)。

    **批内作用域 + 定点批量**(Codex 七轮 perf):只扫 ``batch_id`` 本批含 fuzzy 条目的 P-CASE;从其
    raw 一次收锚(``law_content_code``),**单次** bulk 查 effective P-EXT chunks 建
    ``source_code → {doc_no, clause_path_norm, title}`` 映射,再逐案**只升级命中锚的 fuzzy 条目**、
    其余原样保留(``align_cited`` 与 ``_align_violated`` 逐项 1:1,故按位对齐升级)。**无命中锚的案例
    (空锚 fuzzy 主体 / 锚未建块)零 DB 往返**——不再逐案 ``resolve_exact``/``align_cited``。跨批晚到 /
    upcoming→activate / 非锚标题 fuzzy 不在此覆盖,精确恢复走 ``reprocess <dvid>``(重跑 S4 全量对齐,
    见 SPEC-PRESEG §8.3)。

    **失败口径**(Codex 七轮 reliability):raw 已在 S0 校验、S4 读过——此处**只隔离格式损坏**
    (``UnicodeDecodeError``/``JSONDecodeError``:记 warning+计数,留 fuzzy 待 reprocess 补救);
    **存储/基础设施错误不捕获、向上抛**(入口非零退出),不静默留 fuzzy。仅定点改
    ``cited_regulations``/``ref_unresolved`` 两列;无升级不写。返回升级的案例数。
    """
    from common.pg_models import Case, Chunk

    with ctx.db.session() as s:
        targets = s.execute(
            select(DocVersion.doc_version_id, DocVersion.raw_object_key)
            .join(Document, DocVersion.logical_id == Document.logical_id)
            .join(Case, Case.doc_version_id == DocVersion.doc_version_id)
            .where(
                DocVersion.batch_id == batch_id,  # 批内作用域(替全局,无跨批 N+1)
                DocVersion.source_format == "preseg",
                Document.corpus_type == "P-CASE",
                # 含任一 fuzzy 条目(非 exact = 可能可升级);JSONB 下推可 GIN 索引
                Case.cited_regulations.op("@>")([{"match": "fuzzy"}]),
            )
        ).all()
    if not targets:
        return 0

    # 一次收锚:读本批 fuzzy 案例 raw,聚 law_content_code。格式损坏隔离(可 reprocess),存储错上抛。
    parsed: list[tuple[str, list]] = []
    anchors: set[str] = set()
    corrupt = 0
    for dvid, raw_key in targets:
        try:
            rec = json.loads(ctx.object_store.get(raw_key).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:  # 仅格式损坏隔离,非基础设施错
            logger.warning("preseg 对账:案例 %s raw 损坏,跳过(可 reprocess):%s", dvid, e)
            corrupt += 1
            continue
        vregs = rec.get("violated_regulations") or []
        parsed.append((dvid, vregs))
        anchors.update(v["law_content_code"] for v in vregs if v.get("law_content_code"))
    if corrupt:
        logger.warning("preseg 对账 batch=%s:%d 例 raw 损坏未对账", batch_id, corrupt)
    if not anchors:
        return 0  # 本批 fuzzy 案例无任何源锚 → 无可升级 exact,不做无效重算

    # 单次 bulk:effective P-EXT chunks 里这些锚 → source_code 映射(超预算多切块同 code 取任一)
    with ctx.db.session() as s:
        rows = s.execute(
            select(
                Chunk.source_code, DocVersion.doc_number, Chunk.clause_path_norm, DocVersion.title
            )
            .join(DocVersion, Chunk.doc_version_id == DocVersion.doc_version_id)
            .join(Document, DocVersion.logical_id == Document.logical_id)
            .where(
                Chunk.source_code.in_(anchors),
                DocVersion.version_status == "effective",
                Document.corpus_type == "P-EXT",
            )
        ).all()
    code_map: dict[str, dict] = {}
    for src, doc_no, cpn, title in rows:
        code_map.setdefault(src, {"doc_no": doc_no, "clause_path_norm": cpn, "title": title})
    if not code_map:
        return 0  # 锚都还没 effective+建块 → 无升级(退 fuzzy 兜底,reprocess 恢复)

    updated = 0
    for dvid, vregs in parsed:
        # 本案无命中锚 → 无升级,不开 session(空锚/锚未建块案例零 DB 往返)
        if not any(v.get("law_content_code") in code_map for v in vregs):
            continue
        with ctx.db.session() as s:
            case = s.get(Case, dvid)
            if case is None:
                continue
            cited = case.cited_regulations or []
            if len(cited) != len(vregs):
                continue  # 结构不 1:1(如 llm 缝)→ 不动,交 reprocess 全量重算
            changed = False
            new_cited: list = []
            for entry, v in zip(cited, vregs, strict=True):  # 上方 len 守卫保证等长
                lcc = v.get("law_content_code")
                hit = code_map.get(lcc) if lcc else None
                if hit is not None and entry.get("match") == "fuzzy":
                    new_cited.append({
                        "doc_no": hit["doc_no"],
                        "title": v.get("title") or hit["title"],
                        "clause_path_norm": hit["clause_path_norm"],
                        "resolved": True,
                        "match": "exact",
                    })
                    changed = True
                else:
                    new_cited.append(entry)
            if not changed:
                continue  # 命中锚位已是 exact(幂等)→ 不写
            case.cited_regulations = new_cited
            case.ref_unresolved = any(not e.get("resolved") for e in new_cited)
        updated += 1
    return updated


def _align_violated(vregs: list, lookup) -> tuple[list, bool]:
    """违反法规子表 → cited_regulations(**精确桥接优先,fuzzy 回落**),保序。

    每条:有 ``law_content_code`` 且锚在库(effective P-EXT)→ 精确取**同一 chunk** 的
    ``doc_no``+``clause_path_norm``(与 query 侧 ``norm_ref`` 逐位一致,``resolved=True``,exact);
    否则单条走 ``align_cited`` fuzzy 标题对齐(fuzzy,保序)。任一未解析 → 聚合 ``ref_unresolved``
    (仅置标记,不阻塞入库,§9)。``match`` 字段供观测精确/模糊命中比,query 侧忽略不消费。
    """
    from pipeline.meta.case_ref_align import align_cited

    out: list = []
    unresolved = False
    for v in vregs:
        lcc = v.get("law_content_code")
        exact = lookup.resolve_exact(lcc) if lcc else None
        if exact is not None:
            out.append({
                "doc_no": exact["doc_no"],
                "title": v.get("title") or exact["title"],
                "clause_path_norm": exact["clause_path_norm"],
                "resolved": True,
                "match": "exact",
            })
            continue
        rows, u = align_cited([{"title": v.get("title"), "clause": v.get("clause_label")}], lookup)
        # match=fuzzy(非 exact = 可能可升级,供对账筛);**不把内部源锚写进 cited_regulations**
        # ——那会泄漏进 query API related_regulations(Codex 四轮 S3)
        for r in rows:
            r["match"] = "fuzzy"
        out.extend(rows)
        unresolved = unresolved or u
    return out, unresolved


def extract_case_structured(ctx: StageContext, dv: DocVersion) -> None:
    """源案例记录(raw JSON)→ cases 行直装:**零 LLM、零正则抽取**。

    违反法规子表经 ``_align_violated`` 归一对齐:**有源锚(law_content_code)→ 精确直连;无锚 →
    ``align_cited``+``PgRegLookup`` fuzzy 标题对齐**(源给的是标题+条款标识,库内锚点是
    doc_no+clause_path_norm);对齐失败照旧仅置 ``ref_unresolved`` 标记不阻塞(§9 现状口径)。
    persons 原样照存(D6)。respondent 单值列 = persons 首条(兼容既有消费面);全量在 persons。
    """
    from pipeline.meta.reg_lookup import PgRegLookup

    rec = json.loads(ctx.object_store.get(dv.raw_object_key).decode("utf-8"))
    vregs = rec.get("violated_regulations") or []
    aligned, unresolved = _align_violated(vregs, PgRegLookup(ctx.db))

    persons = rec.get("persons") or []
    first = persons[0] if persons else {}
    rtype = first.get("type")
    ctx.db.upsert_case(
        dv.doc_version_id,
        {
            "penalty_org": rec.get("issuing_org"),
            "doc_number": rec.get("doc_number"),
            "penalty_date": _iso_date(rec.get("issue_date")),  # 发文日期≈处罚日期(#17 待样例校核)
            "respondent": first.get("name"),
            "respondent_type": rtype if rtype in ("机构", "个人") else None,
            "violation_category": rec.get("case_type"),  # 值域 vs dict 待校核(#16),直写
            "cited_regulations": aligned,
            "ref_unresolved": unresolved,
            "persons": persons,
            "occurred_at": _iso_date(rec.get("occurred_at")),
            "source_url": rec.get("source_url"),
        },
    )


def build_case_specs_from_record(dvid: str, rec: dict, cfg) -> list:
    """源案例记录 → case chunks(与 case_chunker 同约定:``case/{k}`` 伪路径,k 1-based)。

    - ``case_section`` ← 案例描述(description);
    - ``case_summary`` ← **问题汇总(人工撰写)**,替代规则截断版/默认关的 LLM 摘要(映射 #18);
      缺失时退 case_name。搬运保真:文本原样,零页码(D2)。超预算复用 _split_oversize。
    """
    from common.chunk_id import compute_chunk_id
    from pipeline.chunking.chunker import ChunkSpec, _split_oversize, count_tokens

    parts: list[tuple[str, str, str]] = []  # (name, text, chunk_type)
    if rec.get("description"):
        parts.append(("描述", rec["description"], "case_section"))
    summary = rec.get("problem_summary") or rec.get("case_name") or ""
    if summary:
        parts.append(("摘要", summary, "case_summary"))

    specs: list = []
    k = 0
    for name, text, ctype in parts:
        pieces = (
            _split_oversize(text, cfg.target_token_max)
            if count_tokens(text) > cfg.target_token_max
            else [(text, False)]
        )
        for piece, hard in pieces:
            k += 1
            norm = f"case/{k}"
            specs.append(
                ChunkSpec(
                    chunk_id=compute_chunk_id(dvid, norm, 0),
                    doc_version_id=dvid,
                    clause_path=name,
                    clause_path_norm=norm,
                    seq=0,
                    text=piece,
                    breadcrumb=name,
                    page_start=None,  # D2 零页码
                    page_end=None,
                    token_count=count_tokens(piece),
                    oversize=hard,
                    chunk_type=ctype,
                )
            )
    return specs
