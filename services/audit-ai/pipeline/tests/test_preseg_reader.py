"""T3 接收契约 reader:扩展 manifest 列集精确匹配 + blocks/cases JSONL 行级校验,
坏输入整文件拒收(行级错误汇总),合法 fixtures 全解析。(SPEC-PRESEG §3)"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from common.manifest import REQUIRED_COLUMNS
from pipeline.preseg.reader import (
    PRESEG_REQUIRED_COLUMNS,
    PresegFormatError,
    blocks_content_hash,
    parse_blocks,
    read_blocks,
    read_cases,
    validate_manifest_header,
    validate_manifest_rows,
)

FIXTURES = Path(__file__).parent / "fixtures" / "preseg_batch"


# ── manifest 列集 ──────────────────────────────────────────────


class TestManifestContract:
    def test_extends_base_eleven(self):
        assert PRESEG_REQUIRED_COLUMNS[: len(REQUIRED_COLUMNS)] == REQUIRED_COLUMNS
        assert set(PRESEG_REQUIRED_COLUMNS) >= {
            "source_doc_id", "content_hash", "effective_status",
            "issuer_level_src", "tags", "file_no", "source_created_by",
        }

    def test_exact_header_passes(self):
        validate_manifest_header(list(PRESEG_REQUIRED_COLUMNS))  # 不 raise

    def test_missing_column_rejected(self):
        header = [c for c in PRESEG_REQUIRED_COLUMNS if c != "source_doc_id"]
        with pytest.raises(PresegFormatError, match="source_doc_id"):
            validate_manifest_header(header)

    def test_extra_column_rejected(self):
        with pytest.raises(PresegFormatError, match="page_no"):
            validate_manifest_header([*PRESEG_REQUIRED_COLUMNS, "page_no"])

    def test_rows_require_idempotency_keys(self):
        row = dict.fromkeys(PRESEG_REQUIRED_COLUMNS, "x")
        row.update(corpus_type="P-INT", source_doc_id="", content_hash="h1")
        with pytest.raises(PresegFormatError, match="source_doc_id"):
            validate_manifest_rows([row])

    def test_rows_corpus_type_must_be_partition_value(self):
        # 检索分区归属:corpus_type 仍填 P-INT/P-EXT/P-CASE(preseg 通道性由扩展列标识,
        # 落 P-PRESEG 会脱出主检索分区——B6 红线,SPEC 精化,见 preseg_devlog)
        row = dict.fromkeys(PRESEG_REQUIRED_COLUMNS, "x")
        row.update(corpus_type="P-PRESEG", source_doc_id="s1", content_hash="h1")
        with pytest.raises(PresegFormatError, match="corpus_type"):
            validate_manifest_rows([row])

    def test_rows_valid_pass(self):
        row = dict.fromkeys(PRESEG_REQUIRED_COLUMNS, "x")
        row.update(corpus_type="P-EXT", source_doc_id="s1", content_hash="h1")
        validate_manifest_rows([row])  # 不 raise


# ── blocks JSONL ──────────────────────────────────────────────


class TestBlocks:
    def test_fixture_blocks_parse_sorted(self):
        blocks = read_blocks(FIXTURES / "blocks" / "ext-001.jsonl")
        assert len(blocks) >= 3
        assert [b.block_seq for b in blocks] == sorted(b.block_seq for b in blocks)
        assert all(b.text for b in blocks)
        assert any(b.clause_label for b in blocks)

    def test_missing_text_rejected_with_line_no(self, tmp_path):
        p = tmp_path / "bad.jsonl"
        p.write_text(
            '{"block_seq": 0, "text": "ok"}\n{"block_seq": 1}\n', encoding="utf-8"
        )
        with pytest.raises(PresegFormatError, match="line 2"):
            read_blocks(p)

    def test_duplicate_seq_rejected(self, tmp_path):
        p = tmp_path / "dup.jsonl"
        p.write_text(
            '{"block_seq": 0, "text": "a"}\n{"block_seq": 0, "text": "b"}\n',
            encoding="utf-8",
        )
        with pytest.raises(PresegFormatError, match="block_seq"):
            read_blocks(p)

    def test_empty_file_rejected(self, tmp_path):
        p = tmp_path / "empty.jsonl"
        p.write_text("", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="空"):
            read_blocks(p)

    def test_bad_json_line_aggregated(self, tmp_path):
        p = tmp_path / "badjson.jsonl"
        p.write_text('{"block_seq": 0, "text": "a"}\nnot-json\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="line 2"):
            read_blocks(p)

    def test_non_utf8_blocks_rejected(self, tmp_path):
        # 非法 UTF-8 → PresegFormatError(而非漏 UnicodeDecodeError 绕过隔离,Codex)
        p = tmp_path / "bad_enc.jsonl"
        p.write_bytes(b'{"block_seq": 0, "text": "\xff\xfe"}\n')
        with pytest.raises(PresegFormatError, match="UTF-8"):
            read_blocks(p)

    def test_non_bool_is_table_rejected(self, tmp_path):
        # is_table 字符串 "false" 不得被 bool() 强转成 True(错解表格)→ 拒收
        p = tmp_path / "t.jsonl"
        p.write_text('{"block_seq": 0, "text": "a", "is_table": "false"}\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="is_table"):
            read_blocks(p)

    def test_non_str_clause_label_rejected(self, tmp_path):
        # clause_label 非字符串(数字)→ 后续 normalize 会崩/错解 → 拒收
        p = tmp_path / "c.jsonl"
        p.write_text('{"block_seq": 0, "text": "a", "clause_label": 21}\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="clause_label"):
            read_blocks(p)

    def test_bool_block_seq_rejected(self, tmp_path):
        # block_seq=true 是 int 子类,不得混入当 1 → 拒收
        p = tmp_path / "b.jsonl"
        p.write_text('{"block_seq": true, "text": "a"}\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="block_seq"):
            read_blocks(p)

    # ── CP-010 内网对齐新增字段(source_code / clause_path_norm / is_catalog)──

    def test_new_fields_parse(self, tmp_path):
        p = tmp_path / "n.jsonl"
        p.write_text(
            '{"block_seq": 0, "clause_label": "第一章", "text": "总则", "is_catalog": true}\n'
            '{"block_seq": 1, "clause_label": "第二十一条", "text": "……", '
            '"source_code": "LC-021", "clause_path_norm": "2/21"}\n',
            encoding="utf-8",
        )
        blocks = read_blocks(p)
        assert blocks[0].is_catalog is True
        assert blocks[1].source_code == "LC-021"
        assert blocks[1].clause_path_norm == "2/21"
        assert blocks[1].is_catalog is False  # 缺省 False

    def test_non_bool_is_catalog_rejected(self, tmp_path):
        # 同 is_table:字符串 "true" 不得被 bool() 强转 → 拒收
        p = tmp_path / "ic.jsonl"
        p.write_text('{"block_seq": 0, "text": "a", "is_catalog": "true"}\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="is_catalog"):
            read_blocks(p)

    def test_non_str_source_code_rejected(self, tmp_path):
        p = tmp_path / "sc.jsonl"
        p.write_text('{"block_seq": 0, "text": "a", "source_code": 123}\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="source_code"):
            read_blocks(p)

    def test_non_str_clause_path_norm_rejected(self, tmp_path):
        p = tmp_path / "cpn.jsonl"
        p.write_text('{"block_seq": 0, "text": "a", "clause_path_norm": 21}\n', encoding="utf-8")
        with pytest.raises(PresegFormatError, match="clause_path_norm"):
            read_blocks(p)

    def test_content_hash_includes_new_structural_fields(self):
        # clause_path_norm 进 chunk_id、source_code 决定桥接、is_catalog 决定成不成块 → 必须进指纹,
        # 否则"仅改结构元数据"的变化件被误判 DUPLICATE 漏更新
        base = parse_blocks('{"block_seq": 0, "text": "a", "clause_path_norm": "2/21"}', "b")
        same = parse_blocks(
            '{"text": "a", "block_seq": 0, "clause_path_norm": "2/21"}', "b"
        )  # 仅键序重排
        changed = parse_blocks('{"block_seq": 0, "text": "a", "clause_path_norm": "2/22"}', "b")
        assert blocks_content_hash(base) == blocks_content_hash(same)  # 重格式化不变
        assert blocks_content_hash(base) != blocks_content_hash(changed)  # 路径变→指纹变


# ── cases JSONL ──────────────────────────────────────────────


class TestCases:
    def test_fixture_cases_parse(self):
        cases = read_cases(FIXTURES / "cases.jsonl")
        assert len(cases) >= 2
        c = cases[0]
        assert c.case_name and c.doc_number
        assert c.violated_regulations and c.violated_regulations[0].title
        assert isinstance(c.persons, list) and c.persons  # 多涉案人员样例
        # 边界样例:第二案含款级引用(kuan 由 derive 处理,reader 原样透传)
        labels = [
            v.clause_label for case in cases for v in case.violated_regulations
        ]
        assert any(lbl and "款" in lbl for lbl in labels)

    def test_case_name_required(self, tmp_path):
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps({"doc_number": "x"}) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="case_name"):
            read_cases(p)

    def test_violated_reg_title_required(self, tmp_path):
        rec = {"case_name": "A", "doc_number": "x",
               "violated_regulations": [{"clause_label": "第一条"}]}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="title"):
            read_cases(p)

    def test_persons_must_be_list(self, tmp_path):
        rec = {"case_name": "A", "doc_number": "x", "persons": {"name": "张三"}}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="persons"):
            read_cases(p)

    def test_violated_regulations_must_be_list(self, tmp_path):
        # 非 list(如 dict)→ enumerate 会遍历键/字符静默生成垃圾 → 拒收
        rec = {"case_name": "A", "violated_regulations": {"title": "《X》"}}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="violated_regulations"):
            read_cases(p)

    def test_tags_must_be_list(self, tmp_path):
        rec = {"case_name": "A", "tags": "招揽;展业"}  # 串而非 list
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="tags"):
            read_cases(p)

    def test_non_str_violated_title_rejected(self, tmp_path):
        rec = {"case_name": "A", "violated_regulations": [{"title": 123}]}  # title 非字符串
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="title"):
            read_cases(p)

    def test_persons_item_must_be_object(self, tmp_path):
        # persons=["not-an-object"] → 下游 first.get() 崩 → 拒收(Codex 实测例)
        rec = {"case_name": "A", "persons": ["not-an-object"]}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="persons"):
            read_cases(p)

    def test_non_str_issue_date_rejected(self, tmp_path):
        # issue_date=20260710(int)→ 下游 date.fromisoformat 抛 TypeError → 拒收(Codex 实测例)
        rec = {"case_name": "A", "issue_date": 20260710}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="issue_date"):
            read_cases(p)

    def test_non_str_violated_clause_label_rejected(self, tmp_path):
        # clause_label=21(int)→ 下游条号归一化崩 → 拒收(Codex 实测例)
        rec = {"case_name": "A", "violated_regulations": [{"title": "《X》", "clause_label": 21}]}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="clause_label"):
            read_cases(p)

    def test_non_str_violated_content_rejected(self, tmp_path):
        # content=123(int)→ 违约声明的字符串契约 → 拒收(Codex 实测例)
        rec = {"case_name": "A", "violated_regulations": [{"title": "《X》", "content": 123}]}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="content"):
            read_cases(p)

    def test_non_utf8_cases_rejected(self, tmp_path):
        # 非法 UTF-8 → PresegFormatError(而非漏 UnicodeDecodeError 中止整批,Codex)
        p = tmp_path / "bad_enc.jsonl"
        p.write_bytes(b'{"case_name": "\xff\xfe"}\n')
        with pytest.raises(PresegFormatError, match="UTF-8"):
            read_cases(p)

    # ── CP-010 精确桥接锚(law_code / law_content_code)──

    def test_violated_reg_exact_anchors_parse(self, tmp_path):
        rec = {"case_name": "A", "violated_regulations": [
            {"title": "《X办法》", "clause_label": "第二十一条",
             "law_code": "L-001", "law_content_code": "LC-021"}]}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        v = read_cases(p)[0].violated_regulations[0]
        assert v.law_code == "L-001"
        assert v.law_content_code == "LC-021"

    def test_non_str_law_content_code_rejected(self, tmp_path):
        # law_content_code 非 str → 桥接精确查会用错类型键 → 拒收
        rec = {"case_name": "A", "violated_regulations": [
            {"title": "《X》", "law_content_code": 21}]}
        p = tmp_path / "c.jsonl"
        p.write_text(json.dumps(rec) + "\n", encoding="utf-8")
        with pytest.raises(PresegFormatError, match="law_content_code"):
            read_cases(p)
