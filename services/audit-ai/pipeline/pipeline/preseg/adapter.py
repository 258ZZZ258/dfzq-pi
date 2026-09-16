"""P-PRESEG 块流 → ChunkSpec 适配器(CP-010 T7,SPEC-PRESEG §4-S3)。

**搬运保真**:源块文本原样入 chunk(不加面包屑前缀、不改写正文——源即权威切块);
本模块只做四件事:norm 推导接线(章节上下文继承)、seq 分配(同 norm 多块递增)、
超预算二次切分(复用 chunker._split_oversize 纯文本链)、文档级适用对象继承(D7)。

- 章/节标题块:更新上下文,**不成块**(与条款树"章节点不出 chunk"一致);
- 推导失败块:伪路径 ``preseg/{block_seq}``;有 ``source_code`` 的达梦详情正文仍标为
  ``clause``（可参与内规核查），无源锚的自由备注才为 ``preseg_raw``，后者可检索但不参与
  引用末段对齐；批次占比是推导器健康信号(告警阈值 ⚠ 待样例标定);
- 零页码(D2):page_start/page_end 恒 None,引用三级;
- chunk_id 走既有 ``compute_chunk_id(dvid, norm, seq)``,幂等契约不变(B1)。
"""

from __future__ import annotations

from collections import Counter

from common.chunk_id import compute_chunk_id
from pipeline.chunking.chunker import ChunkSpec, _split_oversize, count_tokens
from pipeline.config import ChunkConfig
from pipeline.preseg.derive import derive_norm
from pipeline.preseg.reader import PresegBlock


def build_preseg_specs(
    dvid: str,
    blocks: list[PresegBlock],
    cfg: ChunkConfig,
    entity_types: list | None = None,
) -> list[ChunkSpec]:
    """预切块块流 → 同构 ChunkSpec 列表(下游 s3 落库/s5 索引零感知)。"""
    specs: list[ChunkSpec] = []
    seq_counter: Counter[str] = Counter()
    chapter: str | None = None
    section: str | None = None
    chapter_raw: str | None = None
    section_raw: str | None = None

    for b in sorted(blocks, key=lambda x: x.block_seq):
        d = derive_norm(b.clause_label)
        raw = (b.clause_label or "").strip()
        # 结构标题块:is_catalog(源 IS_CATALOG,权威)优先,回落 derive 的 chapter/section 判别。
        # 目录节点不出 chunk(与 clause_tree「章节点不出 chunk」一致),仅更新面包屑上下文。
        if b.is_catalog or d.kind in ("chapter", "section"):
            if d.kind == "section":
                chapter = d.chapter or chapter
                section, section_raw = d.section, raw
            else:  # chapter,或 is_catalog 但非"第X章/节"形态(如"总则")→ 当章级,清空节
                chapter, chapter_raw = d.chapter, raw
                section, section_raw = None, None
            continue

        # 正文块的 norm 与 chunk_type:权威 clause_path_norm(源 PATH_CODE 算好)优先——
        # 有它即真条款,绝不落伪路径;无则回落 derive(推导失败仍落伪路径,降级留痕)。
        if b.clause_path_norm:
            norm = b.clause_path_norm
            chunk_type = "table" if b.is_table else "clause"
        elif d.kind == "article":
            parts = [d.chapter or chapter, d.section or section, d.norm]
            norm = "/".join(p for p in parts if p)
            chunk_type = "table" if b.is_table else "clause"
        else:  # 推导失败 → 伪路径,不阻塞入库(降级留痕)
            norm = f"preseg/{b.block_seq}"
            # 真实内网内规中，LAW_CONTENT_DETAIL 的一行就是一个可核查正文段，
            # 但常没有“第X条”标签。存在源节点锚时仍作为 clause 入库；只有既无
            # 结构标签、也无源锚的自由备注才保持 preseg_raw，避免混入覆盖核查。
            chunk_type = "table" if b.is_table else ("clause" if b.source_code else "preseg_raw")

        label = raw
        breadcrumb = " > ".join(p for p in (chapter_raw, section_raw, label) if p)
        pieces = (
            _split_oversize(b.text, cfg.target_token_max)
            if count_tokens(b.text) > cfg.target_token_max
            else [(b.text, False)]
        )
        for piece, hard_cut in pieces:
            seq = seq_counter[norm]
            seq_counter[norm] += 1
            specs.append(
                ChunkSpec(
                    chunk_id=compute_chunk_id(dvid, norm, seq),
                    doc_version_id=dvid,
                    clause_path=label,
                    clause_path_norm=norm,
                    seq=seq,
                    text=piece,
                    breadcrumb=breadcrumb,
                    page_start=None,  # D2 零页码,引用三级
                    page_end=None,
                    token_count=count_tokens(piece),
                    is_table=b.is_table,
                    oversize=hard_cut,
                    chunk_type=chunk_type,
                    entity_type=list(entity_types) if entity_types else None,  # D7 文档级继承
                    source_code=b.source_code,  # CP-010 精确桥接锚(LAW_CONTENT.CODE),透传到 chunks
                )
            )
    return specs
