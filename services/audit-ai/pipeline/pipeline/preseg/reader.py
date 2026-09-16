"""P-PRESEG 接收契约 reader(CP-010 T3,SPEC-PRESEG §3)。

批次目录 = 扩展 manifest.xlsx + blocks/<filename>.jsonl(每文档一件)+ cases.jsonl(案例批次)。
源系统实际导出形态由**批次目录之外的薄转换脚本**吸收(接缝);本模块只认本契约,坏输入
**整文件拒收**(行级错误汇总报出),绝不带病入库。

口径钉子(SPEC 精化,详见 preseg_devlog):manifest 的 ``corpus_type`` 列仍填
``P-INT/P-EXT/P-CASE``——它是 Milvus 分区/检索归属(B6),preseg 落自立分区会脱出主检索;
preseg **通道性**由扩展列(source_doc_id/content_hash)与 dv 级 ``source_format="preseg"``
标识,QC 档案键才用 ``P-PRESEG``(profiles.yaml)。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from common.manifest import OPTIONAL_VERSION_COLUMNS, REQUIRED_COLUMNS

#: 扩展列(SPEC §3.2):幂等键两分量 + 源元数据。列集精确匹配,缺/多整批拒收(承 s0 语义)。
#: CP-010 内网对齐补 source_law_id(LAW_BASIC.SOURCE_LAW_ID,版本链源)+ invalid_date
#: (LAW_BASIC.INVALID_DATE,失效日期 provenance;效力状态仍由 effective_status→status_map 源权威)。
PRESEG_EXTRA_COLUMNS = [
    "source_doc_id", "content_hash", "effective_status",
    "issuer_level_src", "entity_types", "tags", "file_no", "source_created_by",
    "source_law_id", "invalid_date",
]
PRESEG_REQUIRED_COLUMNS = [*REQUIRED_COLUMNS, *PRESEG_EXTRA_COLUMNS]

#: corpus_type 允许值 = 检索分区归属(见模块 docstring 口径钉子)
_ALLOWED_CORPUS = {"P-INT", "P-EXT", "P-CASE"}


class PresegFormatError(ValueError):
    """接收契约违约(列集/行级校验失败)→ 整文件/整批拒收。"""


@dataclass(frozen=True)
class PresegBlock:
    block_seq: int
    text: str
    clause_label: str | None = None
    is_table: bool = False
    # ── CP-010 内网 8 表对齐(可空;老批次不带→回落现有行为)──
    source_code: str | None = None  # 源条款锚 LAW_CONTENT.CODE(精确桥接落点)
    clause_path_norm: str | None = None  # 转换脚本从 PATH_CODE 算好的权威 norm(缺→回落 derive)
    is_catalog: bool = False  # IS_CATALOG==1 → 章节标题块(不成 chunk;替代 derive 章/节判别)


@dataclass(frozen=True)
class ViolatedReg:
    title: str
    clause_label: str | None = None
    content: str | None = None
    # ── CP-010 精确桥接:源已算好的条款外键(缺→回落 title/clause 模糊对齐)──
    law_code: str | None = None  # ZNFG_IAM_LAW_BASIC.CODE
    law_content_code: str | None = None  # ZNFG_IAM_LAW_CONTENT.CODE → 直连 chunks.source_code


@dataclass(frozen=True)
class PresegCase:
    case_name: str
    source_case_id: str | None = None  # 源系统案例主键(幂等键;缺失时退 record_hash)
    record_hash: str = ""  # reader 计算的记录规范化哈希(幂等键第二分量,源侧无需提供)
    doc_number: str | None = None  # 发文文号
    issuing_org: str | None = None  # 发文单位
    issue_date: str | None = None  # 发文日期(ISO 串,类型待样例)
    occurred_at: str | None = None  # 发生时间
    case_type: str | None = None
    problem_summary: str | None = None  # → case_summary chunk 文本源
    description: str | None = None  # → case_section chunk 文本源
    source_url: str | None = None
    tags: list = field(default_factory=list)
    violated_regulations: list[ViolatedReg] = field(default_factory=list)
    persons: list[dict] = field(default_factory=list)  # 原样照存 cases.persons JSONB(D6)


def validate_manifest_header(header: list) -> None:
    """列集**精确匹配**(与 s0 制度类 manifest 同语义):缺列/多列整批拒收。"""
    got = [str(h) for h in header if h is not None]
    missing = [c for c in PRESEG_REQUIRED_COLUMNS if c not in got]
    extra = [c for c in got if c not in [*PRESEG_REQUIRED_COLUMNS, *OPTIONAL_VERSION_COLUMNS]]
    if missing or extra:
        raise PresegFormatError(
            f"P-PRESEG manifest 列集不匹配:缺失 {missing or '无'};多余 {extra or '无'}"
        )


def validate_manifest_rows(rows: list[dict]) -> None:
    """行级契约:幂等键两分量非空 + corpus_type 必须是检索分区值。"""
    errors: list[str] = []
    for i, row in enumerate(rows, start=2):  # xlsx 数据行从第 2 行起
        for key in ("source_doc_id", "content_hash"):
            if not str(row.get(key) or "").strip():
                errors.append(f"row {i}: 幂等键 {key} 为空")
        ct = str(row.get("corpus_type") or "").strip()
        if ct not in _ALLOWED_CORPUS:
            errors.append(
                f"row {i}: corpus_type={ct!r} 非法——preseg 批次仍须填检索分区值 "
                f"{sorted(_ALLOWED_CORPUS)}(通道性由扩展列标识,勿填 P-PRESEG)"
            )
    if errors:
        raise PresegFormatError("manifest 行级校验失败:\n" + "\n".join(errors))


def _read_text(path: Path) -> str:
    """读文件文本;非法 UTF-8 → PresegFormatError(而非漏 UnicodeDecodeError 绕过隔离/中止批次)。"""
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise PresegFormatError(f"{path.name}: 非法 UTF-8 编码,无法解码({e})") from e


def read_blocks(path: Path) -> list[PresegBlock]:
    """blocks JSONL 文件 → 块列表(见 parse_blocks)。"""
    return parse_blocks(_read_text(path), path.name)


def parse_blocks(text: str, name: str) -> list[PresegBlock]:
    """blocks JSONL 文本 → 按 block_seq 升序的块列表;任何行级违约汇总后整体拒收。

    与 read_blocks 分离:S1 装载分支从 ObjectStore 取 raw bytes 直接解析(无本地文件)。
    """
    records = _parse_jsonl(text, name)
    if not records:
        raise PresegFormatError(f"{name}: 空 blocks 文件")
    errors: list[str] = []
    blocks: list[PresegBlock] = []
    seen_seq: set[int] = set()
    for lineno, rec in records:
        seq = rec.get("block_seq")
        blk_text = rec.get("text")
        clause_label = rec.get("clause_label")
        is_table = rec.get("is_table", False)
        is_catalog = rec.get("is_catalog", False)
        source_code = rec.get("source_code")
        clause_path_norm = rec.get("clause_path_norm")
        # bool 是 int 子类:显式排除,否则 block_seq=true 会被当 1 混入(错序/重号)
        if not isinstance(seq, int) or isinstance(seq, bool):
            errors.append(f"line {lineno}: block_seq 缺失或非整数")
            continue
        if seq in seen_seq:
            errors.append(f"line {lineno}: block_seq={seq} 重复")
            continue
        if not isinstance(blk_text, str) or not blk_text.strip():
            errors.append(f"line {lineno}: text 缺失或为空")
            continue
        if clause_label is not None and not isinstance(clause_label, str):
            t = type(clause_label).__name__
            errors.append(f"line {lineno}: clause_label 须为字符串(得 {t})")
            continue
        if not isinstance(is_table, bool):  # 勿 bool() 强转——"false"/0/[] 会被误判(错解表格)
            errors.append(f"line {lineno}: is_table 须为布尔(得 {type(is_table).__name__})")
            continue
        # ── CP-010 新增字段严校验(同口径:出现即须正确类型,否则整文件拒收)──
        if not isinstance(is_catalog, bool):  # 同 is_table:勿 bool() 强转
            errors.append(f"line {lineno}: is_catalog 须为布尔(得 {type(is_catalog).__name__})")
            continue
        bad_str = next(
            (f"line {lineno}: {k} 须为字符串(得 {type(rec.get(k)).__name__})"
             for k in ("source_code", "clause_path_norm")
             if rec.get(k) is not None and not isinstance(rec.get(k), str)),
            None,
        )
        if bad_str:
            errors.append(bad_str)
            continue
        seen_seq.add(seq)
        blocks.append(
            PresegBlock(
                block_seq=seq,
                text=blk_text,
                clause_label=clause_label or None,
                is_table=is_table,
                source_code=source_code or None,
                clause_path_norm=clause_path_norm or None,
                is_catalog=is_catalog,
            )
        )
    if errors:
        raise PresegFormatError(f"{name} 行级校验失败:\n" + "\n".join(errors))
    return sorted(blocks, key=lambda b: b.block_seq)


def blocks_content_hash(blocks: list[PresegBlock]) -> str:
    """块内容**语义规范化哈希**:对解析后的块记录(按 block_seq 排序 + 稳定字段序)→ sha256。

    仅重格式化(空格 / JSON 键序 / 换行)不改哈希,真实内容变化才改——对齐 SPEC 的 content_hash 语义
    (**明确替代文件字节 sha**;字节 sha 会把纯重排误判为内容变而错误隔离)。作 s0 源幂等去重的内容
    指纹:声明 content_hash 命中时再交叉核验此指纹,失真才隔离(非静默丢弃变化件)。
    """
    canon = [
        {"block_seq": b.block_seq, "text": b.text,
         "clause_label": b.clause_label, "is_table": b.is_table,
         # CP-010:三者实质影响产物(norm→chunk_id、source_code→桥接、is_catalog→成不成块),
         # 纳入指纹,否则"仅改结构元数据"的变化件被误判 DUPLICATE 而漏更新
         "source_code": b.source_code, "clause_path_norm": b.clause_path_norm,
         "is_catalog": b.is_catalog}
        for b in sorted(blocks, key=lambda b: b.block_seq)
    ]
    payload = json.dumps(canon, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_cases(path: Path) -> list[PresegCase]:
    """cases JSONL → PresegCase 列表;case_name 必填、violated_regulations[].title 必填、
    persons 须为 list(内容原样照存,D6 不做字段级裁剪)。"""
    records = _read_jsonl(path)
    if not records:
        raise PresegFormatError(f"{path.name}: 空 cases 文件")
    errors: list[str] = []
    cases: list[PresegCase] = []
    for lineno, rec in records:
        case_name = rec.get("case_name")
        if not isinstance(case_name, str) or not case_name.strip():
            errors.append(f"line {lineno}: case_name 必填且须为字符串")
            continue
        persons = rec.get("persons", [])
        if not isinstance(persons, list):
            errors.append(f"line {lineno}: persons 必须是 list")
            continue
        if not all(isinstance(p, dict) for p in persons):  # 每项须 object → 下游 first.get() 才不崩
            errors.append(f"line {lineno}: persons 每项须为 object")
            continue
        tags = rec.get("tags", [])
        if not isinstance(tags, list):  # 非 list(如 "a;b" 串)→ 后续检索/展示错解
            errors.append(f"line {lineno}: tags 必须是 list")
            continue
        # 各字符串字段类型校验:日期串(issue_date/occurred_at)非 str → 下游 date.fromisoformat 抛
        # TypeError;其余串字段非 str 违约。缺(None)允许。
        str_err = _bad_str_field(rec, lineno)
        if str_err:
            errors.append(str_err)
            continue
        vregs_raw = rec.get("violated_regulations", [])
        if not isinstance(vregs_raw, list):  # 非 list → enumerate 会遍历键/字符,静默生成垃圾
            errors.append(f"line {lineno}: violated_regulations 必须是 list")
            continue
        vregs: list[ViolatedReg] = []
        bad = False
        for j, v in enumerate(vregs_raw):
            if not isinstance(v, dict):
                errors.append(f"line {lineno}: violated_regulations[{j}] 须为 object")
                bad = True
                break
            title = v.get("title")
            if not isinstance(title, str) or not title.strip():
                errors.append(f"line {lineno}: violated_regulations[{j}].title 必填且须为字符串")
                bad = True
                break
            # clause_label 非 str → 下游条号归一化崩;content 非 str 违约声明契约。缺(None)允许。
            # law_code/law_content_code(CP-010 精确锚)非 str → 桥接精确查用错类型键。缺(None)允许。
            sub_err = next(
                (f"line {lineno}: violated_regulations[{j}].{k} 须为字符串"
                 for k in ("clause_label", "content", "law_code", "law_content_code")
                 if v.get(k) is not None and not isinstance(v.get(k), str)),
                None,
            )
            if sub_err:
                errors.append(sub_err)
                bad = True
                break
            vregs.append(
                ViolatedReg(
                    title=title,
                    clause_label=v.get("clause_label") or None,
                    content=v.get("content") or None,
                    law_code=v.get("law_code") or None,
                    law_content_code=v.get("law_content_code") or None,
                )
            )
        if bad:
            continue
        cases.append(
            PresegCase(
                case_name=case_name,
                source_case_id=str(rec.get("source_case_id") or "") or None,
                record_hash=_record_hash(rec),
                doc_number=rec.get("doc_number") or None,
                issuing_org=rec.get("issuing_org") or None,
                issue_date=rec.get("issue_date") or None,
                occurred_at=rec.get("occurred_at") or None,
                case_type=rec.get("case_type") or None,
                problem_summary=rec.get("problem_summary") or None,
                description=rec.get("description") or None,
                source_url=rec.get("source_url") or None,
                tags=tags,
                violated_regulations=vregs,
                persons=persons,
            )
        )
    if errors:
        raise PresegFormatError(f"{path.name} 行级校验失败:\n" + "\n".join(errors))
    return cases


#: 案例可空字符串字段:出现即须为 str(日期串下游进 date.fromisoformat,类型错会抛未捕获 TypeError)
_CASE_STR_FIELDS = (
    "source_case_id", "doc_number", "issuing_org", "issue_date", "occurred_at",
    "case_type", "problem_summary", "description", "source_url",
)


def _bad_str_field(rec: dict, lineno: int) -> str | None:
    """首个类型不符的字符串字段错误消息(None=全部合法)。"""
    for f in _CASE_STR_FIELDS:
        val = rec.get(f)
        if val is not None and not isinstance(val, str):
            return f"line {lineno}: {f} 须为字符串(得 {type(val).__name__})"
    return None


def _record_hash(rec: dict) -> str:
    """记录规范化哈希(sort_keys JSON → sha256):案例幂等键第二分量,源侧无需提供。"""
    canon = json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _read_jsonl(path: Path) -> list[tuple[int, dict]]:
    return _parse_jsonl(_read_text(path), path.name)


def _parse_jsonl(text: str, name: str) -> list[tuple[int, dict]]:
    """JSONL 文本 → [(行号, 记录)];坏 JSON 行汇总拒收。"""
    errors: list[str] = []
    out: list[tuple[int, dict]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"line {lineno}: 非法 JSON({e.msg}")
            continue
        if not isinstance(rec, dict):
            errors.append(f"line {lineno}: 记录须为 JSON object")
            continue
        out.append((lineno, rec))
    if errors:
        raise PresegFormatError(f"{name} JSON 解析失败:\n" + "\n".join(errors))
    return out
