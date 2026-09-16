"""对话上传文档 · 按需处理轻链(context-first,无状态,不经 PG 状态机)。

复用两个纯核心:``make_parser().parse(bytes)->ParseResult`` + ``build_specs(IR, corpus_type)
->ChunkSpec``;用合成 handle ``upload:{upload_id}`` 当身份(复用 chunk_id 公式,幂等)。产物落
ObjectStore ``artifact/{upload_id}.json``(MinIO 后端时即 MinIO)。

**不写权威 PG、不进状态机、不跑版本链/META/finalize/T2/T4/嵌入**(嵌入是 post-MVP 比对/大文档才用)。
见 docs/upload-processing-docs/SPEC-UPLOAD-PROCESSING.md。
"""

from __future__ import annotations

import hashlib
from pathlib import PurePosixPath

from common.ir import IRDocument, SourceFormat
from pipeline.chunking.profile_router import build_specs
from pipeline.config import ChunkConfig, Settings
from pipeline.index.object_store import ObjectTooLargeError
from pipeline.ondemand.artifact import (
    ArtifactChunk,
    ArtifactDoc,
    ArtifactSource,
    UploadArtifact,
)
from pipeline.parsing.adapter import ParseResult
from pipeline.parsing.factory import make_parser


class UnsupportedUploadType(ValueError):
    """上传类型不在白名单 / 无解析器(端点映射 415)。"""


class UploadParseFailed(RuntimeError):
    """解析失败(端点映射 500,带 reason)。"""


class UploadTooLarge(ValueError):
    """上传对象超过按需处理允许的最大字节数(端点映射 413)。"""


# 扩展名 → (source_format, content_type);Excel 暂无解析器(post-MVP,§8)
_EXT_MAP = {
    "pdf": ("pdf", "application/pdf"),
    "docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "png": ("png", "image/png"),
    "jpg": ("jpg", "image/jpeg"),
    "jpeg": ("jpg", "image/jpeg"),
}
# corpus_hint → 切块 profile;缺省/未知 → P-INT(制度条款树,profile_router 亦对未知回退条款树)
_HINT_MAP = {"internal": "P-INT", "external": "P-EXT", "qa": "P-QA", "case": "P-CASE"}


def handle_for(upload_id: str) -> str:
    """合成 doc handle 作 chunk_id 公式的身份位(``upload:{upload_id}``,确定性 → 幂等)。"""
    return f"upload:{upload_id}"


def detect_format(filename: str) -> tuple[str, str]:
    """按扩展名判 (source_format, content_type);非白名单 → ``UnsupportedUploadType``。"""
    ext = PurePosixPath(filename).suffix.lstrip(".").lower()
    if ext not in _EXT_MAP:
        raise UnsupportedUploadType(f"不支持的上传类型 .{ext}(白名单 pdf/docx/png/jpg)")
    return _EXT_MAP[ext]


def _render_markdown(title: str | None, chunks: list[ArtifactChunk]) -> str:
    """整篇渲染供直接 context stuffing:标题作 H1 + 各叶块正文(已含面包屑条款路径)。"""
    parts: list[str] = []
    if title:
        parts.append(f"# {title}")
    parts.extend(c.text for c in chunks)
    return "\n\n".join(parts)


def build_artifact(
    *,
    upload_id: str,
    source: ArtifactSource,
    source_format: str,
    parse_result: ParseResult,
    corpus_type: str,
    chunk_cfg: ChunkConfig,
) -> UploadArtifact:
    """纯核心:ParseResult → 合成 IR → build_specs → 结构化 artifact(+ markdown)。无 IO。"""
    handle = handle_for(upload_id)
    ir = IRDocument(
        doc_version_id=handle,
        source_format=SourceFormat(source_format),
        blocks=parse_result.blocks,
        page_count=parse_result.page_count,
        title=parse_result.title,
    )
    specs = build_specs(ir, corpus_type, chunk_cfg)
    # 叶块即全文覆盖;去父块(节级聚合)避免重复
    chunks = [
        ArtifactChunk(
            seq=s.seq,
            clause_path=s.clause_path,
            chunk_type=s.chunk_type,
            text=s.text,
            page_start=s.page_start,
            page_end=s.page_end,
            is_table=s.is_table,
        )
        for s in specs
        if not s.is_parent
    ]
    return UploadArtifact(
        upload_id=upload_id,
        source=source,
        doc=ArtifactDoc(
            title=parse_result.title, page_count=parse_result.page_count, chunk_count=len(chunks)
        ),
        chunks=chunks,
        markdown=_render_markdown(parse_result.title, chunks),
    )


def process_upload(
    object_store,
    settings: Settings,
    *,
    object_key: str,
    upload_id: str,
    filename: str,
    corpus_hint: str | None = None,
    max_bytes: int = 50 * 1024 * 1024,
) -> UploadArtifact:
    """轻链编排:从 ObjectStore 拉 raw → 解析 → 结构化 → 写 artifact → 返回产物。

    ``object_store`` 鸭子类型(``get(key)->bytes`` + ``put_artifact(upload_id, bytes)``);本地
    ObjectStore 或 MinIO 后端均可。幂等:同 ``upload_id`` 重跑覆盖同 artifact。
    """
    source_format, content_type = detect_format(filename)
    try:
        data = object_store.get(object_key, max_bytes=max_bytes)
    except ObjectTooLargeError as exc:
        raise UploadTooLarge(f"上传文件超过 {max_bytes} 字节") from exc
    result = make_parser().parse(
        data, source_format, scanned_char_per_page_max=settings.parse.scanned_char_per_page_max
    )
    if not result.ok:
        raise UploadParseFailed(result.reason or f"解析失败(code={result.error_code})")
    corpus_type = _HINT_MAP.get((corpus_hint or "").lower(), "P-INT")
    source = ArtifactSource(
        filename=filename,
        object_key=object_key,
        sha256=hashlib.sha256(data).hexdigest(),
        content_type=content_type,
    )
    artifact = build_artifact(
        upload_id=upload_id,
        source=source,
        source_format=source_format,
        parse_result=result,
        corpus_type=corpus_type,
        chunk_cfg=settings.chunk,
    )
    object_store.put_artifact(upload_id, artifact.model_dump_json().encode("utf-8"))
    return artifact
