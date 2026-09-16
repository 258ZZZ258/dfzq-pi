"""T3(CP-012):audit_corpus_schema(sparse_backend) 分形态。零栈(schema 对象断言,不连栈)。

- bge 形态逐字段对拍现状(byte 等价)、无 function。
- bm25 形态:字段全集不变、text 开 analyzer、挂 Function(BM25) 产 sparse_vec。
"""

from __future__ import annotations

from pymilvus import DataType, FunctionType

from common.milvus_schema import audit_corpus_schema

# §8.2 字段全集(bge 形态必须逐字段一致;bm25 只 text 开 analyzer + 加 function,字段集不变)
_EXPECTED_FIELDS = [
    ("chunk_id", DataType.VARCHAR),
    ("dense_vec", DataType.FLOAT_VECTOR),
    ("sparse_vec", DataType.SPARSE_FLOAT_VECTOR),
    ("doc_id", DataType.VARCHAR),
    ("doc_version_id", DataType.VARCHAR),
    ("corpus_type", DataType.VARCHAR),
    ("sub_type", DataType.VARCHAR),
    ("status", DataType.VARCHAR),
    ("perm_tag", DataType.ARRAY),
    ("biz_domain", DataType.ARRAY),
    ("issuer_level", DataType.INT8),
    ("entity_type", DataType.ARRAY),
    ("chunk_type", DataType.VARCHAR),
    ("clause_path", DataType.VARCHAR),
    ("source_code", DataType.VARCHAR),  # CP-010 citation:DM 回查键(merge feat/citation-source-code)
    ("source_doc_id", DataType.VARCHAR),
    ("page_start", DataType.INT64),
    ("effective_date", DataType.INT64),
    ("text", DataType.VARCHAR),
    ("degraded", DataType.BOOL),
]


def _fields(schema):
    return [(f.name, f.dtype) for f in schema.fields]


def test_default_is_bge_byte_equivalent():
    schema = audit_corpus_schema()  # 默认 = bge
    assert _fields(schema) == _EXPECTED_FIELDS
    assert list(schema.functions) == []  # 无 function


def test_bge_form_no_analyzer_no_function():
    bge = audit_corpus_schema("bge")
    assert _fields(bge) == _EXPECTED_FIELDS
    assert list(bge.functions) == []
    text = next(f for f in bge.fields if f.name == "text")
    assert not text.params.get("enable_analyzer")  # bge:text 不开 analyzer


def test_bm25_fields_unchanged():
    assert _fields(audit_corpus_schema("bm25")) == _EXPECTED_FIELDS  # 字段全集不变


def test_bm25_has_bm25_function_text_to_sparse():
    bm25 = audit_corpus_schema("bm25")
    assert len(bm25.functions) == 1
    fn = bm25.functions[0]
    assert fn.type == FunctionType.BM25
    assert fn.input_field_names == ["text"]
    assert fn.output_field_names == ["sparse_vec"]


def test_bm25_text_analyzer_enabled():
    text = next(f for f in audit_corpus_schema("bm25").fields if f.name == "text")
    assert text.params.get("enable_analyzer") is True


def test_bm25_analyzer_type_configurable():
    text = next(
        f for f in audit_corpus_schema("bm25", analyzer_type="standard").fields if f.name == "text"
    )
    assert "standard" in text.params.get("analyzer_params", "")
