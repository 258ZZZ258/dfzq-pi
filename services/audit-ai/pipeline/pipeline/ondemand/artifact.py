"""上传文档中间产物模型(context-first):结构化 chunks + 渲染 markdown,供下游作 LLM 上下文。

任务无关——同一份 artifact 可喂问答/总结/抽取。MVP **不含向量**(post-MVP 比对/大文档才加
``chunks[].embedding``)。落 ObjectStore ``artifact/{upload_id}.json``(MinIO 后端时即 MinIO)。
见 docs/upload-processing-docs/SPEC-UPLOAD-PROCESSING.md §4.1。
"""

from __future__ import annotations

from pydantic import BaseModel


class ArtifactSource(BaseModel):
    filename: str
    object_key: str  # Java 上传到 MinIO 的 raw 对象 key
    sha256: str
    content_type: str


class ArtifactDoc(BaseModel):
    title: str | None = None
    page_count: int | None = None
    chunk_count: int


class ArtifactChunk(BaseModel):
    """一个结构化切块(叶块):带条款路径 + 页范围,供 LLM 按条引用。"""

    seq: int
    clause_path: str
    chunk_type: str  # clause | table | qa | case_* …(与语料库同构)
    text: str  # 面包屑前缀 + 正文(ChunkSpec.text)
    page_start: int | None = None
    page_end: int | None = None
    is_table: bool = False


class UploadArtifact(BaseModel):
    upload_id: str
    source: ArtifactSource
    doc: ArtifactDoc
    chunks: list[ArtifactChunk]
    markdown: str  # 整篇渲染,供直接 context stuffing
