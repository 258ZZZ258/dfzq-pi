"""R2 条款级 diff(§6.2 变更内容):按 ``clause_path_norm`` 对齐两版本条款。纯函数、零 LLM。

仅到**条款级**:两侧 text 不等=changed、仅新=added、仅旧=removed、相等不计(字句级 diff 后续)。
若某条在新旧版本的路径不同、但正文严格相同且两侧正文都唯一，则记为 moved（位置调整）。
移动匹配先于同路径内容比较：第 4/5 条互换时两侧路径仍重叠，若先按路径比较会误报两个修改。
入参元素含 ``clause_path_norm`` / ``text`` / ``seq``(由 ``r2_change.fetch_clause_chunks`` 提供)。
**同 ``clause_path_norm`` 的多子块**(切块器拆超长条款/表格)按 ``seq`` 升序**聚合拼接**后比较——
后续子块差异不漏。输出按 path 字符串序(确定性)。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from pipeline.chunking.normalize import normalize_clause_no, strip_ws, to_halfwidth


@dataclass(frozen=True)
class ClauseChange:
    clause_path_norm: str
    kind: str  # added | removed | changed | moved
    old_text: str | None
    new_text: str | None
    old_clause_path_norm: str | None = None
    new_clause_path_norm: str | None = None


def _key(x) -> str:
    return x["clause_path_norm"] if isinstance(x, dict) else x.clause_path_norm


def _text(x) -> str:
    return (x["text"] if isinstance(x, dict) else x.text) or ""


def _seq(x) -> int:
    v = x["seq"] if isinstance(x, dict) else getattr(x, "seq", 0)
    return v if v is not None else 0


def _aggregate(chunks: list) -> dict[str, str]:
    """同 clause_path_norm 的多子块按 seq 升序拼接(覆盖切块器对超长条款/表格的拆分)。"""
    groups: dict[str, list] = {}
    for c in chunks:
        groups.setdefault(_key(c), []).append(c)
    return {
        path: "\n".join(_text(i) for i in sorted(items, key=_seq))
        for path, items in groups.items()
    }


def _canonical_clause_path(path: str) -> str:
    """用于版本对齐的条款路径规范形，保留原始路径供界面展示。

    历史导入数据有时写 ``1``，有时写 ``第一条``。二者是同一条款号，不能因
    字面格式不同而产生一次 ``moved``。路径可能带章节层级，因此只规范可识别的
    "第 X 条" / "X" 叶子节点；其它层级原样保留，避免把未知路径误合并。
    """
    value = strip_ws(to_halfwidth(str(path or "")))
    if not value:
        return value

    def canonical_part(part: str) -> str:
        match = re.fullmatch(r"第(.+)条", part)
        clause_no = match.group(1) if match else part
        try:
            return normalize_clause_no(clause_no)
        except ValueError:
            return part

    return "/".join(canonical_part(part) for part in value.split("/"))


def diff_clauses(old: list, new: list) -> list[ClauseChange]:
    """聚合子块 → 对齐 → 变更项(added/removed/changed/moved),按路径字符串稳定输出。"""
    old_map = _aggregate(old)
    new_map = _aggregate(new)

    changes: list[ClauseChange] = []
    # 先对齐仅因条款号书写形式不同的条款（如 ``1`` / ``第一条``）。
    # 不能用原始 path 直接比较，否则它们会在下方的同正文匹配中被误判为 moved。
    old_by_canonical_path: dict[str, list[str]] = {}
    new_by_canonical_path: dict[str, list[str]] = {}
    for path in old_map:
        old_by_canonical_path.setdefault(_canonical_clause_path(path), []).append(path)
    for path in new_map:
        new_by_canonical_path.setdefault(_canonical_clause_path(path), []).append(path)

    equivalent_path_pairs: dict[str, str] = {}
    for canonical_path, old_paths in old_by_canonical_path.items():
        new_paths = new_by_canonical_path.get(canonical_path, [])
        # 仅处理两侧唯一的非原始同名路径，避免重复脏数据被不安全地合并。
        if len(old_paths) == 1 and len(new_paths) == 1 and old_paths[0] != new_paths[0]:
            equivalent_path_pairs[new_paths[0]] = old_paths[0]

    equivalent_old_paths = set(equivalent_path_pairs.values())
    equivalent_new_paths = set(equivalent_path_pairs)
    for new_path, old_path in equivalent_path_pairs.items():
        if old_map[old_path] != new_map[new_path]:
            changes.append(
                ClauseChange(new_path, "changed", old_map[old_path], new_map[new_path])
            )

    # 全局先配对两侧唯一的完全相同正文。不能只看 old_only/new_only：条款互换位置时
    # 两个路径依旧同时存在，先做同路径比较会把纯位置调整误判成 changed。
    old_text_paths: dict[str, list[str]] = {}
    new_text_paths: dict[str, list[str]] = {}
    for path, text in old_map.items():
        if path in equivalent_old_paths:
            continue
        old_text_paths.setdefault(text, []).append(path)
    for path, text in new_map.items():
        if path in equivalent_new_paths:
            continue
        new_text_paths.setdefault(text, []).append(path)
    moved_pairs = {
        new_paths[0]: old_paths[0]
        for text, old_paths in old_text_paths.items()
        if len(old_paths) == 1
        and len(new_paths := new_text_paths.get(text, [])) == 1
        and old_paths[0] != new_paths[0]
    }
    moved_old_paths = set(moved_pairs.values())
    moved_new_paths = set(moved_pairs)

    old_only = {
        path: text
        for path, text in old_map.items()
        if path not in new_map and path not in moved_old_paths and path not in equivalent_old_paths
    }
    new_only = {
        path: text
        for path, text in new_map.items()
        if path not in old_map and path not in moved_new_paths and path not in equivalent_new_paths
    }

    for path in sorted(set(old_map) & set(new_map)):
        if path in moved_old_paths or path in moved_new_paths:
            continue
        if old_map[path] != new_map[path]:
            changes.append(ClauseChange(path, "changed", old_map[path], new_map[path]))
    for path in sorted(moved_pairs):
        old_path = moved_pairs[path]
        changes.append(
            ClauseChange(
                path,
                "moved",
                old_map[old_path],
                new_map[path],
                old_clause_path_norm=old_path,
                new_clause_path_norm=path,
            )
        )
    for path in sorted(new_only):
        changes.append(ClauseChange(path, "added", None, new_map[path]))
    for path in sorted(old_only):
        changes.append(ClauseChange(path, "removed", old_map[path], None))

    return sorted(changes, key=lambda change: (change.clause_path_norm, change.kind))
