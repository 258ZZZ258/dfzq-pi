"""解析产物 → 达梦 8 表行(CP-013)。**纯函数,不碰 DB**,便于单测与离线核对。

输入 = manifest 行(11 列契约)+ IR + 条款树;输出 = ``LAW_BASIC`` 一行 + ``LAW_CONTENT`` N 行
+ ``LAW_CONTENT_DETAIL`` M 行(**正文在这里**)。

**树是现成的**:``clause_tree.build_tree`` 产出的 ``ClauseNode`` 本就是树(``build_chunks`` 才把它
压平成 ChunkSpec),故这里直接消费树,不做"扁平路径还原树"那种反向工程。

复刻甲方形态的几处(照抄,便于下游 preseg 走同一条路):
- 每部法规先写一个 **INDEX_NO=0 的空根节点**(TITLE/CONTENT 空,IS_CATALOG=0);
- **章/节 → IS_CATALOG=1**(标题节点,无正文);**条 → IS_CATALOG=0**(条款节点);
- ``PATH_CODE``:catalog 与根 = 自身 CODE;条 = 最近 catalog CODE + "." + 自身 CODE;
- **正文落 ``LAW_CONTENT_DETAIL``,``LAW_CONTENT.CONTENT`` 一律空串**(2026-07-29 内网复核:
  在册主表 445,477 行里 445,475 行 CONTENT 为空,正文全在详情表)。段按 ``CONTENT_ORDER``
  排、``CONTENT_TYPE=0`` 标文本;一个 IR 块 = 一段,与该列"同一条款下的文本片段顺序"语义对齐。
  下游 ``preseg.export`` 按同一口径(主表空 → 回退详情、按 ORDER 用 ``\n`` 拼)读回,**逐字往返**。

**刻意不复刻的一处**:甲方每个逻辑节点有 **2 条物理行**(同 CODE、异 ID、内容一致)——那是其 ETL
的缺陷,我方写 **1 行**。下游 ``preseg.export`` 的按-CODE 去重对 1 行同样安全(去重是幂等的)。

**款/项/目不单独成行**(CP-010 决策 D5「舍款取条」):其正文经 ``collect_block_indices()``
合并进所属条的 CONTENT,款号原文不丢。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime

from common.ir import Block, BlockType
from pipeline.chunking.chunker import count_tokens
from pipeline.chunking.clause_tree import ClauseNode, NodeType
from pipeline.dm_sink.codes import content_code, law_code, snowflake_id

#: ETL 来源系统码(CHAR(4))。标明这批行由我方管线产出,与甲方 ETL 灌的区分开。
ETL_SRC_CODE = "AIDP"

#: corpus_type → SCOPE(0=外规 1=内规 2=标准)。达梦只有法规表,P-QA/P-CASE 不走本路径。
_SCOPE_BY_CORPUS = {"P-EXT": 0, "P-INT": 1}

#: manifest 的中文 sub_type → 甲方 LEVELS 英文枚举。未命中则原样包成单元素数组
#: (LEVELS 是 JSON 数组串,不是裸值——真数据 A5 证实)。
_LEVELS_BY_SUBTYPE = {
    "法律": "NATIONAL_LAWS",
    "行政法规": "ADMINISTRATIVE_REGULATIONS",
    "部门规章": "DEPARTMENTAL_RULES",
    "规范性文件": "NORMATIVE_DOC",
    "司法解释": "JUDICIAL_INTERPRETATION",
    "地方性法规": "LOCAL_REGULATIONS",
    "通知公告": "NOTIFICATION_ANNOUNCEMENT",
    "自律规则": "SECURITIES_ASSOCIATION",
    "行业规则": "INDUSTRY_LAWS",
}

#: 达梦列宽(建表即此,超宽会被库直接拒),映射时按此截断/校验。
_W_NAME, _W_DOC_NO, _W_AUTH, _W_TITLE = 400, 2000, 4000, 2000


class DmSinkError(ValueError):
    """该文档不可安全映射(如 corpus_type 不属法规)→ 跳过该件,不带病写库。"""


@dataclass
class DmRows:
    """一份文档的达梦行集。``contents`` 恒无正文,正文在 ``content_details``。"""

    law: dict
    contents: list[dict] = field(default_factory=list)
    content_details: list[dict] = field(default_factory=list)

    @property
    def code(self) -> str:
        return self.law["code"]


def levels_of(sub_type: object) -> str:
    """sub_type → ``LEVELS`` JSON 数组串。空 → 空串(真库有 4 条空值,合法)。"""
    s = str(sub_type or "").strip()
    if not s:
        return ""
    return json.dumps([_LEVELS_BY_SUBTYPE.get(s, s)], ensure_ascii=False)


def _iso(v: object) -> date | None:
    """manifest 日期(可能是 date/datetime/字符串/None)→ date。不可解析即 None,不猜。"""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v or "").strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _fit(v: object, width: int) -> str | None:
    """落定长列的值:超宽截断(fake 库,元数据完整性让位于链路可跑)。空 → None。"""
    s = str(v or "").strip()
    if not s:
        return None
    return s[:width]


def _catalog_title(node: ClauseNode) -> str:
    """章/节标题:"第一章 总则"(编号 + 名称,同甲方形态)。标题行原文通常已含编号。"""
    label, title = (node.raw_label or "").strip(), (node.title or "").strip()
    if title and label and not title.startswith(label):
        return f"{label} {title}"
    return title or label


def _article_title(node: ClauseNode) -> str:
    """条节点 TITLE = **纯条款标识**(如 "第二十一条" / "1.1"),正文一律归 CONTENT。

    ⚠ 不能直接用 ``node.title``:小数编号体例(「1.1 为了规范……」)的条标题行**就是正文段落**,
    整段塞进 TITLE 会让下游 ``preseg.derive`` 推不出 ``clause_path_norm``——推导器吃的是
    ``clause_label``(即本列),拿到一整段话必然失配 → 全件落 ``preseg/{n}`` 伪路径 + 降级标记,
    条款级引用随之失效。甲方真库 TITLE 恒为纯标识,此处对齐。
    """
    return (node.raw_label or "").strip()


def _body_segments(node: ClauseNode, blocks: dict[int, Block]) -> list[str]:
    """条节点正文的**文本片段序列**:本节点 + 全部后代(款/项/目)的非表格块,按文档序。

    ``collect_block_indices`` 已含后代 → 款/项/目 自然并入所属条(D5 舍款取条)。
    标题行本身(block_index)在片段中保留:与甲方正文含条文全文的形态一致。

    **一块一段**(而非整条拼成一段):``CONTENT_ORDER`` 的语义就是"同一条款下的文本片段顺序",
    款/项各自成段才用得上它。下游按 ``\\n`` 重新拼接 → 与"整条一段"逐字等价,故拆段无损。
    """
    return [
        blocks[i].text.strip()
        for i in node.collect_block_indices()
        if i in blocks and blocks[i].type is not BlockType.TABLE and blocks[i].text.strip()
    ]


def map_law_basic(row: dict, code: str, *, has_content: bool, now: datetime) -> dict:
    """manifest 行 → ``ZNFG_IAM_LAW_BASIC`` 一行。

    ⚠ ``corpus_type`` 不在法规两类内(P-QA/P-CASE)→ 抛 DmSinkError:达梦无问答表,案例走
    CASE_* 三表(本轮不做),不能硬塞进 LAW_BASIC 污染法规库。
    """
    corpus = str(row.get("corpus_type") or "").strip()
    scope = _SCOPE_BY_CORPUS.get(corpus)
    if scope is None:
        raise DmSinkError(f"corpus_type={corpus!r} 不属法规(仅 P-EXT/P-INT 走 LAW_BASIC)")
    issue, effective = _iso(row.get("issue_date")), _iso(row.get("effective_date"))
    return {
        "etl_src_date": int(now.strftime("%Y%m%d")),
        "etl_src_code": ETL_SRC_CODE,
        "id": snowflake_id(code),
        "old_id": "",
        "scope": scope,
        "code": code,
        "name": _fit(row.get("title"), _W_NAME),
        "doc_no": _fit(row.get("doc_number"), _W_DOC_NO),
        "issue_auth_cn": _fit(row.get("issuer"), _W_AUTH),
        "issue_auth_code": "",
        # manifest 无「适用对象」列;甲方该列亦有 38% 为空 → 留空合法
        "suit_obj_code": "",
        "issue_date": issue,
        "invalid_date": None,
        # 生效日缺失时回落发布日:达梦侧 EFFECT_DATE 是下游 upcoming 判定的输入
        "effect_date": effective or issue,
        "status_code": "inuse",          # 新入库恒现行有效;废止/修订由后续版本链动作改
        "modify_info": "",
        "forbidden_msg": "",
        "source_law_id": "",             # 与甲方一致:占位空串,非 NULL
        "levels": levels_of(row.get("sub_type")),
        "tag": "",
        "create_time": now,
        "update_time": now,
        "del_flag": "A",
        "has_content": 1 if has_content else 0,
        "data_version": "1",
        "owner": None,
        "source": None,
        "new_code": "",
        "abolish_code": "",
        "creator_id": ETL_SRC_CODE,
        "updator_id": ETL_SRC_CODE,
        "ext_01": None, "ext_02": None, "ext_03": None,
    }


def _plain_groups(ir_blocks: list[Block], budget: int) -> list[str]:
    """无条款体文档的兜底切分:非表格段落按 token 预算聚合成若干正文块。

    **为什么必须兜底**:``build_tree`` 只认 章/节/条 标题,像"业务办理指南""关于…的公告"
    这类无「第X条」体例的文档建出的树只有 ROOT(实测 50 篇真语料里 11 篇如此,占 22%)。
    若原样写库,该法规在达梦侧只剩一个空根节点、``HAS_CONTENT=0`` → 下游 ``preseg.export``
    按"无正文"整件跳过 → **文档静默丢失**。故这里按预算聚合成正文节点,标题留空
    (达梦 ``TITLE`` 可空;下游推导器会落 ``preseg/{n}`` 伪路径并带降级标记,是既有先例)。
    """
    texts = [
        b.text.strip()
        for b in ir_blocks
        if b.type is not BlockType.TABLE and b.text.strip()
    ]
    groups: list[str] = []
    cur: list[str] = []
    size = 0
    for t in texts:
        n = count_tokens(t)
        if cur and size + n > budget:
            groups.append("\n".join(cur))
            cur, size = [], 0
        cur.append(t)
        size += n
    if cur:
        groups.append("\n".join(cur))
    return groups


def map_law_contents(
    code: str, root: ClauseNode, ir_blocks: list[Block], *, now: datetime,
    plain_budget: int = 600,
) -> tuple[list[dict], list[dict]]:
    """条款树 → (``ZNFG_IAM_LAW_CONTENT`` 行, ``ZNFG_IAM_LAW_CONTENT_DETAIL`` 行)。

    ``INDEX_NO`` = 前序序号(0-based,含根节点),即法规内全局顺序 —— 甲方语义如此
    (真数据里有空洞,我方顺延不留洞,不影响排序语义)。
    **正文一律进详情表,主表 ``CONTENT`` 恒空串**(与真库同构)。
    """
    blocks = {b.index: b for b in ir_blocks}
    law_id = snowflake_id(code)
    etl_date = int(now.strftime("%Y%m%d"))
    rows: list[dict] = []
    details: list[dict] = []
    seq = 0

    def emit(*, is_catalog: int, title: str, segments: list[str], path: str) -> str:
        nonlocal seq
        node_code = content_code(code, seq)
        rows.append({
            "etl_src_date": etl_date,
            "etl_src_code": ETL_SRC_CODE,
            "id": snowflake_id(node_code), "old_id": "",
            "code": node_code, "law_id": law_id, "law_code": code,
            "path_code": path, "is_catalog": is_catalog,
            "title": _fit(title, _W_TITLE) or "", "index_no": seq,
            "content": "",  # 与真库同构:主表不存正文
            "create_time": now, "creator_name": ETL_SRC_CODE, "creator_id": ETL_SRC_CODE,
            "update_time": now, "updator_id": ETL_SRC_CODE,
            "del_flag": "A", "data_version": "1",
            "new_content_code": "", "new_path_code": "", "new_law_code": "",
        })
        for order, seg in enumerate(segments):
            details.append({
                "etl_src_date": etl_date, "etl_src_code": ETL_SRC_CODE,
                # ID 按 (节点 CODE, 段序) 派生 → 与 law/content CODE 同样确定性,重跑同 ID
                "id": snowflake_id(f"{node_code}#{order}"),
                "law_code": code, "law_content_code": node_code,
                "content_order": order,
                "content_type": 0,  # 0=文本;图片/视频(1/2)我方不产
                "content": seg,
                "create_time": now, "creator_id": ETL_SRC_CODE,
                "update_time": now, "updator_id": ETL_SRC_CODE,
                "del_flag": "A", "data_version": "1",
            })
        seq += 1
        return node_code

    # 空根节点:复刻甲方形态(INDEX_NO=0,无标题无正文)。下游 export 按"无 text"跳过它。
    emit(is_catalog=0, title="", segments=[], path=content_code(code, 0))

    def walk(node: ClauseNode, catalog_path: str | None) -> None:
        for child in node.children:
            if child.type in (NodeType.CHAPTER, NodeType.SECTION):
                # 章/节 = 目录节点:自身 CODE 即 PATH_CODE(同甲方,不串完整祖先链)
                own = content_code(code, seq)
                emit(is_catalog=1, title=_catalog_title(child), segments=[], path=own)
                walk(child, own)
            elif child.type is NodeType.ARTICLE:
                own = content_code(code, seq)
                path = f"{catalog_path}.{own}" if catalog_path else own
                emit(is_catalog=0, title=_article_title(child),
                     segments=_body_segments(child, blocks), path=path)
                # 款/项/目 已并入本条正文(D5),不再下探
            else:
                walk(child, catalog_path)

    walk(root, None)

    # 兜底:树里一个条文节点都没有(无「第X条」体例)→ 段落按预算聚合成无标题正文节点。
    # 判据用"有没有产出正文段"而非"树是否为空":有章无条的文档同样会漏掉全部正文。
    if not details:
        for text in _plain_groups(ir_blocks, plain_budget):
            emit(is_catalog=0, title="", segments=[text], path=content_code(code, seq))
    return rows, details


def map_document(
    row: dict, ir_blocks: list[Block], root: ClauseNode, *, now: datetime,
    plain_budget: int = 600,
) -> DmRows:
    """一份文档 → 达梦行集。``row`` 为 manifest 行(11 列契约)。"""
    code = law_code(str(row["filename"]))
    contents, details = map_law_contents(code, root, ir_blocks, now=now, plain_budget=plain_budget)
    # 根节点恒存在、主表 CONTENT 恒空 → 「有正文」只能以详情段为准(不能再看主表 CONTENT)
    return DmRows(law=map_law_basic(row, code, has_content=bool(details), now=now),
                  contents=contents, content_details=details)
