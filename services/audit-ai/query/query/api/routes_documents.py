"""Internal uploaded-document processing boundary used by dfzq-pi task-runtime."""

from __future__ import annotations

from datetime import date
from pathlib import PurePosixPath
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from pipeline.config import load_config
from pipeline.index.object_store import ObjectStore
from pipeline.ondemand.artifact import UploadArtifact
from pipeline.ondemand.process import (
    UnsupportedUploadType,
    UploadParseFailed,
    UploadTooLarge,
    process_upload,
)
from query.api.auth import require_internal_token
from query.api.errors import ApiError

router = APIRouter(tags=["boundary"])


class DocumentProcessRequest(BaseModel):
    object_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., pattern=r"^[A-Za-z0-9_-]{1,128}$")
    filename: str = Field(..., min_length=1, max_length=255)
    corpus_hint: Literal["internal", "external", "qa", "case"] | None = None

    @model_validator(mode="after")
    def validate_storage_reference(self):
        if "/" in self.filename or "\\" in self.filename or self.filename in {".", ".."}:
            raise ValueError("filename 必须是单一文件名")
        key = PurePosixPath(self.object_key)
        expected = PurePosixPath("upload") / self.upload_id / self.filename
        if key.is_absolute() or any(part in {"", ".", ".."} for part in key.parts):
            raise ValueError("object_key 不合法")
        if key != expected:
            raise ValueError("object_key 必须绑定 upload_id 和 filename")
        return self


class DocumentProcessResponse(BaseModel):
    upload_id: str
    artifact_key: str
    title: str | None
    page_count: int | None
    chunk_count: int
    chunk_types: list[str]
    status: Literal["completed"]


class DocumentProcessor:
    def __init__(self, object_store, settings) -> None:
        self.object_store = object_store
        self.settings = settings

    @classmethod
    def from_config(cls):
        settings = load_config()
        return cls(ObjectStore.from_config(settings), settings)

    def process(self, body: DocumentProcessRequest) -> UploadArtifact:
        return process_upload(
            self.object_store,
            self.settings,
            object_key=body.object_key,
            upload_id=body.upload_id,
            filename=body.filename,
            corpus_hint=body.corpus_hint,
        )


class ExternalDocumentCatalogItem(BaseModel):
    logical_id: str
    doc_version_id: str
    title: str
    version_label: str
    version_status: str
    version_code: str | None = None
    version_display_name: str | None = None
    revision_no: int | None = None
    doc_number: str | None = None
    issue_date: date | None = None
    effective_date: date | None = None
    supersedes_version_id: str | None = None
    source_doc_id: str | None = None


class ExternalDocumentClause(BaseModel):
    seq: int
    clause_path: str | None = None
    text: str
    page_start: int | None = None
    page_end: int | None = None


class ExternalLibraryDocument(BaseModel):
    doc_version_id: str
    title: str
    doc_no: str | None = None
    clauses: list[ExternalDocumentClause]


class InternalDocumentCatalogItem(ExternalDocumentCatalogItem):
    pass


class InternalLibraryDocument(ExternalLibraryDocument):
    pass


class InternalReferenceClause(BaseModel):
    chunk_id: str
    clause_path: str | None = None
    text: str = Field(..., min_length=1)


class InternalReferenceVersionCheckRequest(BaseModel):
    doc_version_id: str | None = None
    clauses: list[InternalReferenceClause] | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    perm_tags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_source(self):
        if bool(self.doc_version_id) == bool(self.clauses):
            raise ValueError("doc_version_id 与 clauses 必须且只能提供一个")
        if self.effective_from and self.effective_to and self.effective_from > self.effective_to:
            raise ValueError("effective_from 不能晚于 effective_to")
        return self


class VersionDiffRequest(BaseModel):
    """Two explicitly selected versions of one logical library document."""

    new_doc_version_id: str = Field(..., min_length=1, max_length=128)
    old_doc_version_id: str = Field(..., min_length=1, max_length=128)
    perm_tags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_versions(self):
        if self.new_doc_version_id == self.old_doc_version_id:
            raise ValueError("新旧版本必须不同")
        return self


class VersionDiffDocument(BaseModel):
    doc_version_id: str
    title: str
    version_label: str
    # 新版库返回真实状态；旧 DocumentLibrary 实现未提供该字段时保持历史响应可解析。
    version_status: str = "effective"
    version_code: str | None = None
    version_display_name: str | None = None
    revision_no: int | None = None
    issue_date: date | None = None
    effective_date: date | None = None


class VersionDiffMetrics(BaseModel):
    added: int
    removed: int
    changed: int
    moved: int
    total: int


class VersionDiffRow(BaseModel):
    index: int
    tab_key: Literal["added", "removed", "changed", "moved"]
    clause_path: str
    old_clause_path: str | None = None
    new_clause_path: str | None = None
    old_text: str | None = None
    new_text: str | None = None
    change_type: Literal["added", "removed", "changed", "moved"]


class VersionDiffResponse(BaseModel):
    compare_type: Literal["version_diff"]
    corpus_type: Literal["internal", "external"]
    logical_id: str
    new_version: VersionDiffDocument
    old_version: VersionDiffDocument
    metrics: VersionDiffMetrics
    rows: list[VersionDiffRow]


class DocumentLibrary:
    def __init__(self, pg) -> None:
        self.pg = pg

    @classmethod
    def from_config(cls):
        from pipeline.index.pg_io import PgIO

        return cls(PgIO.from_config(load_config()))

    @staticmethod
    def _allowed_tags(perm_tags: list[str]) -> list[str]:
        return sorted({"public", *[tag for tag in perm_tags if tag]})

    @staticmethod
    def _version_metadata(version) -> dict[str, object]:
        """目录对外提供持久化版本字段；遗留数据仅作明确标识的兼容回退。"""
        revision_no = version.revision_no
        version_code = version.version_code or (f"LEGACY-{revision_no:04d}" if revision_no else None)
        version_display_name = version.version_display_name or version.version_code or (
            f"历史导入版本 {revision_no}" if revision_no else "历史导入版本"
        )
        # version_label 是旧消费者兼容字段，不再把年份伪装成版本号。
        return {
            "version_label": version_display_name,
            "version_code": version_code,
            "version_display_name": version_display_name,
            "revision_no": revision_no,
        }

    @classmethod
    def _catalog_item(cls, doc, version) -> dict[str, object]:
        return {
            "logical_id": doc.logical_id,
            "doc_version_id": version.doc_version_id,
            "title": version.title or doc.title or version.source_filename or version.doc_version_id,
            **cls._version_metadata(version),
            "version_status": version.version_status,
            "doc_number": version.doc_number or version.file_no,
            "issue_date": version.issue_date,
            "effective_date": version.effective_date,
            "supersedes_version_id": version.supersedes_version_id,
            "source_doc_id": version.source_doc_id,
        }

    def list_external_documents(self, perm_tags: list[str], include_history: bool = False):
        from common.pg_models import Document, DocVersion

        allowed = self._allowed_tags(perm_tags)
        with self.pg.session() as session:
            rows = session.execute(
                select(Document, DocVersion)
                .join(DocVersion, DocVersion.logical_id == Document.logical_id)
                .where(
                    Document.corpus_type == "P-EXT",
                    DocVersion.pipeline_status == "INDEXED",
                    DocVersion.version_status.in_(
                        ["effective", "upcoming", "superseded"]
                        if include_history
                        else ["effective", "upcoming"]
                    ),
                    DocVersion.perm_tag.in_(allowed),
                )
                .order_by(Document.title, DocVersion.issue_date.desc().nullslast(), DocVersion.doc_version_id)
            ).all()
            return [self._catalog_item(doc, version) for doc, version in rows]

    def list_internal_documents(self, perm_tags: list[str], include_history: bool = False):
        from common.pg_models import Document, DocVersion

        allowed = self._allowed_tags(perm_tags)
        with self.pg.session() as session:
            rows = session.execute(
                select(Document, DocVersion)
                .join(DocVersion, DocVersion.logical_id == Document.logical_id)
                .where(
                    Document.corpus_type == "P-INT",
                    DocVersion.pipeline_status.in_(["INDEXED", "EMBEDDING"]),
                    DocVersion.version_status.in_(
                        ["effective", "upcoming", "superseded"]
                        if include_history
                        else ["effective", "upcoming"]
                    ),
                    DocVersion.perm_tag.in_(allowed),
                )
                .order_by(Document.title, DocVersion.issue_date.desc().nullslast(), DocVersion.doc_version_id)
            ).all()
            return [self._catalog_item(doc, version) for doc, version in rows]

    def get_external_document(self, doc_version_id: str, perm_tags: list[str]):
        from common.pg_models import Chunk, Document, DocVersion

        allowed = self._allowed_tags(perm_tags)
        with self.pg.session() as session:
            row = session.execute(
                select(Document, DocVersion)
                .join(DocVersion, DocVersion.logical_id == Document.logical_id)
                .where(
                    DocVersion.doc_version_id == doc_version_id,
                    Document.corpus_type == "P-EXT",
                    DocVersion.pipeline_status == "INDEXED",
                    DocVersion.version_status.in_(["effective", "upcoming"]),
                    DocVersion.perm_tag.in_(allowed),
                )
            ).first()
            if row is None:
                return None
            doc, version = row
            chunks = session.scalars(
                select(Chunk)
                .where(
                    Chunk.doc_version_id == doc_version_id,
                    Chunk.chunk_status == "effective",
                    Chunk.is_parent.is_(False),
                    Chunk.degraded.is_(False),
                    Chunk.chunk_type == "clause",
                )
                .order_by(Chunk.seq)
            ).all()
            return {
                "doc_version_id": version.doc_version_id,
                "title": version.title or doc.title or version.source_filename or version.doc_version_id,
                "doc_no": version.doc_number,
                "clauses": [
                    {
                        "seq": chunk.seq,
                        "clause_path": chunk.clause_path,
                        "text": chunk.text,
                        "page_start": chunk.page_start,
                        "page_end": chunk.page_end,
                    }
                    for chunk in chunks
                ],
            }

    def get_internal_document(self, doc_version_id: str, perm_tags: list[str]):
        from common.pg_models import Chunk, Document, DocVersion

        allowed = self._allowed_tags(perm_tags)
        with self.pg.session() as session:
            row = session.execute(
                select(Document, DocVersion)
                .join(DocVersion, DocVersion.logical_id == Document.logical_id)
                .where(
                    DocVersion.doc_version_id == doc_version_id,
                    Document.corpus_type == "P-INT",
                    DocVersion.pipeline_status.in_(["INDEXED", "EMBEDDING"]),
                    DocVersion.version_status.in_(["effective", "upcoming"]),
                    DocVersion.perm_tag.in_(allowed),
                )
            ).first()
            if row is None:
                return None
            doc, version = row
            chunks = session.scalars(
                select(Chunk)
                .where(
                    Chunk.doc_version_id == doc_version_id,
                    Chunk.chunk_status == "effective",
                    Chunk.is_parent.is_(False),
                    Chunk.degraded.is_(False),
                    Chunk.chunk_type == "clause",
                )
                .order_by(Chunk.seq)
            ).all()
            return {
                "doc_version_id": version.doc_version_id,
                "title": version.title or doc.title or version.source_filename or version.doc_version_id,
                "doc_no": version.doc_number or version.file_no,
                "clauses": [
                    {
                        "seq": chunk.seq,
                        "clause_path": chunk.clause_path,
                        "text": chunk.text,
                        "page_start": chunk.page_start,
                        "page_end": chunk.page_end,
                    }
                    for chunk in chunks
                ],
            }

    def check_internal_reference_versions(self, body: InternalReferenceVersionCheckRequest):
        from query.change.reference_version_check import (
            InternalClause,
            build_reference_version_result,
            extract_uploaded_internal_references,
            load_library_internal_references,
        )

        if body.doc_version_id:
            references = load_library_internal_references(self.pg, body.doc_version_id, body.perm_tags)
            if references is None:
                return None
        else:
            clauses = [
                InternalClause(item.chunk_id, item.clause_path, item.text)
                for item in (body.clauses or [])
            ]
            references = extract_uploaded_internal_references(self.pg, clauses, body.perm_tags)
        return build_reference_version_result(
            self.pg,
            references,
            body.perm_tags,
            body.effective_from,
            body.effective_to,
        )

    def compare_versions(self, body: VersionDiffRequest):
        """Return a deterministic clause-level diff for two versions of one document."""
        from common.pg_models import Document, DocVersion
        from query.change.r2_change import fetch_clause_chunks
        from query.change.version_diff import diff_clauses

        allowed = self._allowed_tags(body.perm_tags)
        with self.pg.session() as session:
            rows = session.execute(
                select(Document, DocVersion)
                .join(DocVersion, DocVersion.logical_id == Document.logical_id)
                .where(
                    DocVersion.doc_version_id.in_([body.new_doc_version_id, body.old_doc_version_id]),
                    DocVersion.pipeline_status.in_(["INDEXED", "EMBEDDING"]),
                    DocVersion.perm_tag.in_(allowed),
                )
            ).all()

        versions = {version.doc_version_id: (doc, version) for doc, version in rows}
        new_item = versions.get(body.new_doc_version_id)
        old_item = versions.get(body.old_doc_version_id)
        if new_item is None or old_item is None:
            return None
        new_doc, new_version = new_item
        old_doc, old_version = old_item
        if new_doc.logical_id != old_doc.logical_id or new_doc.corpus_type != old_doc.corpus_type:
            raise ApiError(422, "B113", "版本差异比对仅支持同一制度或规则的不同版本")

        changes = diff_clauses(
            fetch_clause_chunks(self.pg, old_version.doc_version_id),
            fetch_clause_chunks(self.pg, new_version.doc_version_id),
        )
        counts = {kind: sum(item.kind == kind for item in changes) for kind in ("added", "removed", "changed", "moved")}

        def version_data(doc, version):
            return {
                "doc_version_id": version.doc_version_id,
                "title": version.title or doc.title or version.source_filename or version.doc_version_id,
                **self._version_metadata(version),
                "version_status": version.version_status,
                "issue_date": version.issue_date,
                "effective_date": version.effective_date,
            }

        return {
            "compare_type": "version_diff",
            "corpus_type": "internal" if new_doc.corpus_type == "P-INT" else "external",
            "logical_id": new_doc.logical_id,
            "new_version": version_data(new_doc, new_version),
            "old_version": version_data(old_doc, old_version),
            "metrics": {**counts, "total": len(changes)},
            "rows": [
                {
                    "index": index,
                    "tab_key": change.kind,
                    "clause_path": change.clause_path_norm,
                    "old_clause_path": change.old_clause_path_norm,
                    "new_clause_path": change.new_clause_path_norm,
                    "old_text": change.old_text,
                    "new_text": change.new_text,
                    "change_type": change.kind,
                }
                for index, change in enumerate(changes, start=1)
            ],
        }


def get_document_library(request: Request):
    library = request.app.state.document_library
    if library is None:
        library = DocumentLibrary.from_config()
        request.app.state.document_library = library
    return library


@router.get("/v1/library/external-documents", response_model=list[ExternalDocumentCatalogItem])
def list_external_documents(
    perm_tag: list[str] = Query(default=[]),
    include_history: bool = Query(default=False),
    _auth: None = Depends(require_internal_token),
    library=Depends(get_document_library),
):
    return library.list_external_documents(perm_tag, include_history)


@router.get("/v1/library/external-documents/{doc_version_id}", response_model=ExternalLibraryDocument)
def get_external_document(
    doc_version_id: str,
    perm_tag: list[str] = Query(default=[]),
    _auth: None = Depends(require_internal_token),
    library=Depends(get_document_library),
):
    document = library.get_external_document(doc_version_id, perm_tag)
    if document is None:
        raise ApiError(404, "B111", "知识库外规版本不存在或无权访问")
    return document


@router.get("/v1/library/internal-documents", response_model=list[InternalDocumentCatalogItem])
def list_internal_documents(
    perm_tag: list[str] = Query(default=[]),
    include_history: bool = Query(default=False),
    _auth: None = Depends(require_internal_token),
    library=Depends(get_document_library),
):
    return library.list_internal_documents(perm_tag, include_history)


@router.get("/v1/library/internal-documents/{doc_version_id}", response_model=InternalLibraryDocument)
def get_internal_document(
    doc_version_id: str,
    perm_tag: list[str] = Query(default=[]),
    _auth: None = Depends(require_internal_token),
    library=Depends(get_document_library),
):
    document = library.get_internal_document(doc_version_id, perm_tag)
    if document is None:
        raise ApiError(404, "B112", "知识库内规版本不存在或无权访问")
    return document


@router.post("/v1/internal-reference-version-check")
def check_internal_reference_versions(
    body: InternalReferenceVersionCheckRequest,
    _auth: None = Depends(require_internal_token),
    library=Depends(get_document_library),
):
    result = library.check_internal_reference_versions(body)
    if result is None:
        raise ApiError(404, "B112", "知识库内规版本不存在或无权访问")
    return result


@router.post("/v1/library/version-diff", response_model=VersionDiffResponse)
def compare_library_versions(
    body: VersionDiffRequest,
    _auth: None = Depends(require_internal_token),
    library=Depends(get_document_library),
):
    result = library.compare_versions(body)
    if result is None:
        raise ApiError(404, "B114", "知识库版本不存在或无权访问")
    return result


def get_document_processor(request: Request):
    processor = request.app.state.document_processor
    if processor is None:
        processor = DocumentProcessor.from_config()
        request.app.state.document_processor = processor
    return processor


@router.post("/v1/documents:process", response_model=DocumentProcessResponse)
def process_document(
    body: DocumentProcessRequest,
    _auth: None = Depends(require_internal_token),
    processor=Depends(get_document_processor),
) -> DocumentProcessResponse:
    try:
        artifact = processor.process(body)
    except UnsupportedUploadType as exc:
        raise ApiError(415, "B106", "不支持的文档类型") from exc
    except UploadTooLarge as exc:
        raise ApiError(413, "B107", "文档大小超过 50MB") from exc
    except FileNotFoundError as exc:
        raise ApiError(422, "B108", "上传文件不存在") from exc
    except UploadParseFailed as exc:
        raise ApiError(500, "B109", "文档解析失败") from exc
    except Exception as exc:
        if getattr(exc, "code", None) == "NoSuchKey":
            raise ApiError(422, "B108", "上传文件不存在") from exc
        raise ApiError(500, "B110", "文档处理失败") from exc
    return DocumentProcessResponse(
        upload_id=artifact.upload_id,
        artifact_key=ObjectStore.artifact_key(artifact.upload_id),
        title=artifact.doc.title,
        page_count=artifact.doc.page_count,
        chunk_count=artifact.doc.chunk_count,
        chunk_types=sorted({chunk.chunk_type for chunk in artifact.chunks}),
        status="completed",
    )
