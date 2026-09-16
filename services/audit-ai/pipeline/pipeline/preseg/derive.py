"""clause_label → clause_path_norm 组件推导器(P-PRESEG · CP-010 T2)。

预切块源没有条款树可派生 norm,本模块从源条款标识文本直接推导。**口径逐字对齐实现现状**
(调研澄清①,基准=代码而非设计文档):

- 组件与 ``clause_tree.ClauseNode.clause_path_norm``(`/`-join 全部有编号祖先)一致——
  本模块产出**组件**(chapter/section/article),完整 norm 由 adapter 结合章节上下文拼接;
- 条号归一走 ``normalize.normalize_clause_no``(插入条统一 ``N-K``);
- 小数体例条号(交易所 "2.17"/"10.1.3")**保留原样点分**,与 ``classify_heading``:111-113 同源;
- 款级引用**舍款取条**(决策 D5),款级尾巴原文回带 ``kuan_raw`` 存 JSONB 备查不丢失。

推导失败返回 ``kind=None``、**绝不 raise**——调用方落伪路径 ``preseg/{block_seq}``
(仿 ``qa/{n}``/``case/{k}`` 先例,SPEC-PRESEG §3.3),脏标签不阻塞入库。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 与 clause_tree 同一字符集/条号口径(单一来源,防两处漂移)
from pipeline.chunking.clause_tree import _ART_NUM, _NUM  # noqa: PLC2701
from pipeline.chunking.normalize import (
    normalize_clause_no,
    normalize_radicals,
    strip_ws,
    to_halfwidth,
)

#: 纯小数体例条号(整个 label 就是号本身,如 "2.17"/"10.1.3";章[.节].条)
_DOTTED = re.compile(r"^\d+(?:\.\d+){1,2}$")
# 注意:均经 Pattern.match(s, pos) 使用——match 本身锚定 pos,不能写 ^(^ 恒锚串首,pos>0 时必失配)
_CHAPTER = re.compile(rf"第({_NUM})章")
_SECTION = re.compile(rf"第({_NUM})节")
_ARTICLE = re.compile(rf"第({_ART_NUM})条(?:之({_NUM}))?")
_KUAN_TAIL = re.compile(rf"第{_NUM}款")
#: 宽容兜底:裸数字(含 之N)——源"段落名称"可能只给号不带"第…条"
_BARE = re.compile(rf"^[{_NUM.strip('[]+')}]+(?:之[{_NUM.strip('[]+')}]+)?$")


@dataclass(frozen=True)
class DeriveResult:
    kind: str | None  # "article" | "chapter" | "section" | None(推导失败→伪路径)
    norm: str | None  # 条号组件("21"/"21-1"/"2.17");非 article 时 None
    chapter: str | None  # label 内嵌章号(归一)
    section: str | None  # label 内嵌节号(归一)
    kuan_raw: str | None  # 舍弃的款级尾巴原文(D5 备查),如 "第二款第一项"


_FAIL = DeriveResult(None, None, None, None, None)


def derive_norm(label: str | None) -> DeriveResult:
    """源条款标识 → norm 组件。任何输入都不 raise(失败 = kind None)。"""
    if not label:
        return _FAIL
    s = strip_ws(to_halfwidth(normalize_radicals(label)))
    if not s:
        return _FAIL

    # 纯小数体例(整 label 即号):保留原样点分(与 classify_heading 小数条同口径)
    if _DOTTED.fullmatch(s):
        return DeriveResult("article", s, None, None, None)

    chapter = section = None
    pos = 0
    if m := _CHAPTER.match(s):
        chapter = _norm_or_none(m.group(1))
        pos = m.end()
    if m := _SECTION.match(s, pos):
        section = _norm_or_none(m.group(1))
        pos = m.end()

    if m := _ARTICLE.match(s, pos):
        raw = m.group(1) + (f"之{m.group(2)}" if m.group(2) else "")
        norm = _norm_or_none(raw)
        if norm is not None:
            rest = s[m.end() :]
            kuan = rest if rest and _KUAN_TAIL.match(rest) else None
            return DeriveResult("article", norm, chapter, section, kuan)

    if pos and pos == len(s):  # label 只有章/节(结构标题块)
        if section is not None:
            return DeriveResult("section", None, chapter, section, None)
        return DeriveResult("chapter", None, chapter, None, None)

    # 裸数字兜底(仅整串匹配,避免把任意文本里的数字当条号)
    if pos == 0 and _BARE.fullmatch(s):
        norm = _norm_or_none(s)
        if norm is not None:
            return DeriveResult("article", norm, None, None, None)

    return _FAIL


def _norm_or_none(raw: str) -> str | None:
    try:
        return normalize_clause_no(raw)
    except ValueError:
        return None
