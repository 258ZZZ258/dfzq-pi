"""对话上传按需处理轻链单元:零 PG、零真解析(注入 ParseResult / fake parser)。

detect_format 白名单 · build_artifact 纯核心(ParseResult→结构化 artifact + markdown)· handle 合成 ·
process_upload 端到端(本地 ObjectStore + monkeypatch make_parser)· 幂等 · 解析失败/非白名单。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import pipeline.ondemand.process as proc
from common.ir import Block, BlockType
from pipeline.config import load_config
from pipeline.index.object_store import ObjectStore
from pipeline.ondemand.artifact import ArtifactSource, UploadArtifact
from pipeline.ondemand.process import (
    UnsupportedUploadType,
    UploadParseFailed,
    UploadTooLarge,
    build_artifact,
    detect_format,
    handle_for,
    process_upload,
)
from pipeline.parsing.adapter import ParseResult


def _blocks(texts):
    return [
        Block(index=i, type=BlockType.PARAGRAPH, text=t, page=None) for i, t in enumerate(texts)
    ]


def _ok_result():
    return ParseResult(
        blocks=_blocks(["第一章 总则", "第一条 本办法适用于测试。", "第二条 相关定义如下。"]),
        page_count=1,
        title="某某管理办法",
    )


def _source():
    return ArtifactSource(
        filename="x.pdf", object_key="upload/u1/x.pdf", sha256="ab", content_type="application/pdf"
    )


def _fake_parser(result):
    return SimpleNamespace(parse=lambda data, fmt, **kw: result)


def test_handle_for():
    assert handle_for("u1") == "upload:u1"


def test_detect_format_ok():
    assert detect_format("a.PDF") == ("pdf", "application/pdf")
    assert detect_format("a.docx")[0] == "docx"
    assert detect_format("a.jpeg")[0] == "jpg"


def test_detect_format_unsupported():
    with pytest.raises(UnsupportedUploadType, match="xlsx"):
        detect_format("a.xlsx")


def test_build_artifact_structure():
    cfg = load_config()
    art = build_artifact(
        upload_id="u1", source=_source(), source_format="pdf",
        parse_result=_ok_result(), corpus_type="P-INT", chunk_cfg=cfg.chunk,
    )
    assert isinstance(art, UploadArtifact)
    assert art.upload_id == "u1"
    assert art.doc.title == "某某管理办法"
    assert art.doc.chunk_count == len(art.chunks) > 0
    assert "某某管理办法" in art.markdown
    assert any("第一条" in c.text for c in art.chunks)  # 条款正文进 chunk


def test_build_artifact_deterministic():
    cfg = load_config()
    a1 = build_artifact(upload_id="u1", source=_source(), source_format="pdf",
                        parse_result=_ok_result(), corpus_type="P-INT", chunk_cfg=cfg.chunk)
    a2 = build_artifact(upload_id="u1", source=_source(), source_format="pdf",
                        parse_result=_ok_result(), corpus_type="P-INT", chunk_cfg=cfg.chunk)
    assert a1.model_dump() == a2.model_dump()  # 同输入 → 同产物(handle 确定性)


def test_process_upload_end_to_end(tmp_path, monkeypatch):
    store = ObjectStore(tmp_path)
    raw = tmp_path / "upload" / "u1" / "x.pdf"
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"%PDF fake")
    monkeypatch.setattr(proc, "make_parser", lambda: _fake_parser(_ok_result()))

    art = process_upload(
        store, load_config(), object_key="upload/u1/x.pdf", upload_id="u1", filename="x.pdf"
    )
    assert art.doc.chunk_count > 0
    assert art.source.sha256 == __import__("hashlib").sha256(b"%PDF fake").hexdigest()
    # 产物落库(幂等可复读)
    loaded = UploadArtifact.model_validate_json(store.get_artifact("u1").decode("utf-8"))
    assert loaded.upload_id == "u1"
    assert loaded.markdown == art.markdown


def test_process_upload_unsupported_type(tmp_path):
    store = ObjectStore(tmp_path)
    with pytest.raises(UnsupportedUploadType):
        process_upload(
            store, load_config(), object_key="upload/u1/x.xlsx", upload_id="u1", filename="x.xlsx"
        )


def test_process_upload_parse_failed(tmp_path, monkeypatch):
    store = ObjectStore(tmp_path)
    raw = tmp_path / "upload" / "u1" / "x.pdf"
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"bad")
    monkeypatch.setattr(
        proc, "make_parser",
        lambda: _fake_parser(ParseResult(error_code="E202", reason="扫描件无文本层")),
    )
    with pytest.raises(UploadParseFailed, match="扫描件"):
        process_upload(
            store, load_config(), object_key="upload/u1/x.pdf", upload_id="u1", filename="x.pdf"
        )


def test_process_upload_rejects_object_over_limit_before_parse(tmp_path, monkeypatch):
    store = ObjectStore(tmp_path)
    raw = tmp_path / "upload" / "u1" / "x.pdf"
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"12345")
    parser_called = False

    def _parser():
        nonlocal parser_called
        parser_called = True
        return _fake_parser(_ok_result())

    monkeypatch.setattr(proc, "make_parser", _parser)

    with pytest.raises(UploadTooLarge):
        process_upload(
            store,
            load_config(),
            object_key="upload/u1/x.pdf",
            upload_id="u1",
            filename="x.pdf",
            max_bytes=4,
        )
    assert parser_called is False
