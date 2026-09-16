"""audit-biz/Pi -> audit-ai uploaded-document processing boundary."""

from __future__ import annotations

from fastapi.testclient import TestClient

from pipeline.ondemand.artifact import (
    ArtifactChunk,
    ArtifactDoc,
    ArtifactSource,
    UploadArtifact,
)
from pipeline.ondemand.process import UnsupportedUploadType, UploadParseFailed, UploadTooLarge
from query.api.app import create_app


class _Processor:
    def __init__(self) -> None:
        self.calls = []

    def process(self, request):
        self.calls.append(request)
        return UploadArtifact(
            upload_id=request.upload_id,
            source=ArtifactSource(
                filename=request.filename,
                object_key=request.object_key,
                sha256="abc",
                content_type="application/pdf",
            ),
            doc=ArtifactDoc(title="测试外规", page_count=2, chunk_count=1),
            chunks=[
                ArtifactChunk(
                    seq=0,
                    clause_path="第一条",
                    chunk_type="clause",
                    text="第一条 测试内容",
                    page_start=1,
                    page_end=1,
                )
            ],
            markdown="# 测试外规\n\n第一条 测试内容",
        )


class _FailingProcessor:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def process(self, _request):
        raise self.error


def _client(monkeypatch, processor=None) -> tuple[TestClient, _Processor]:
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "test-token")
    processor = processor or _Processor()
    return TestClient(create_app(document_processor=processor)), processor


class _Library:
    def list_external_documents(self, perm_tags, include_history=False):
        assert perm_tags == ["内部"]
        return [
            {
                "logical_id": "L1",
                "doc_version_id": "V1",
                "title": "测试外规",
                "version_label": "2026版",
                "version_status": "effective",
                "version_code": "V1.2",
                "version_display_name": "2026年第二次修订版",
                "revision_no": 3,
                "doc_number": "北证公告〔2026〕1号",
                "issue_date": "2026-01-01",
                "effective_date": "2026-01-01",
                "supersedes_version_id": "V0",
                "source_doc_id": "SRC1",
            }
        ]

    def get_external_document(self, doc_version_id, perm_tags):
        assert doc_version_id == "V1"
        assert perm_tags == ["内部"]
        return {
            "doc_version_id": "V1",
            "title": "测试外规",
            "doc_no": "北证公告〔2026〕1号",
            "clauses": [{"seq": 0, "clause_path": "第一条", "text": "第一条 测试内容"}],
        }

    def list_internal_documents(self, perm_tags, include_history=False):
        assert perm_tags == ["内部"]
        return [
            {
                "logical_id": "IL1",
                "doc_version_id": "IV1",
                "title": "合同管理办法",
                "version_label": "2026版",
                "version_status": "effective",
            }
        ]

    def get_internal_document(self, doc_version_id, perm_tags):
        assert doc_version_id == "IV1"
        assert perm_tags == ["内部"]
        return {
            "doc_version_id": "IV1",
            "title": "合同管理办法",
            "clauses": [{"seq": 0, "clause_path": "第一条", "text": "依据《证券法》制定本办法"}],
        }

    def check_internal_reference_versions(self, body):
        assert body.doc_version_id == "IV1"
        assert body.perm_tags == ["内部"]
        return {
            "compareType": "internal_to_external",
            "metrics": {"checked": 1, "missing": 0, "conflict": 1, "covered": 0, "unmatched": 0, "linked": 0},
            "rows": [],
            "gaps": [],
            "finish_reason": "stop",
        }

    def compare_versions(self, body):
        assert body.new_doc_version_id == "V2"
        assert body.old_doc_version_id == "V1"
        assert body.perm_tags == ["内部"]
        return {
            "compare_type": "version_diff",
            "corpus_type": "external",
            "logical_id": "L1",
            "new_version": {"doc_version_id": "V2", "title": "测试外规", "version_label": "2026版"},
            "old_version": {"doc_version_id": "V1", "title": "测试外规", "version_label": "2025版"},
            "metrics": {"added": 1, "removed": 0, "changed": 1, "moved": 0, "total": 2},
            "rows": [
                {
                    "index": 1,
                    "tab_key": "changed",
                    "clause_path": "第二条",
                    "old_text": "旧条款",
                    "new_text": "新条款",
                    "change_type": "changed",
                }
            ],
        }


def test_list_external_library_documents(monkeypatch):
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "test-token")
    client = TestClient(create_app(document_library=_Library()))

    response = client.get(
        "/v1/library/external-documents?perm_tag=内部",
        headers={"X-Internal-Token": "test-token"},
    )

    assert response.status_code == 200
    assert response.json()[0]["doc_version_id"] == "V1"
    assert response.json()[0]["version_code"] == "V1.2"
    assert response.json()[0]["version_display_name"] == "2026年第二次修订版"
    assert response.json()[0]["revision_no"] == 3


def test_get_external_library_document_with_clauses(monkeypatch):
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "test-token")
    client = TestClient(create_app(document_library=_Library()))

    response = client.get(
        "/v1/library/external-documents/V1?perm_tag=内部",
        headers={"X-Internal-Token": "test-token"},
    )

    assert response.status_code == 200
    assert response.json()["clauses"] == [
        {"seq": 0, "clause_path": "第一条", "text": "第一条 测试内容", "page_start": None, "page_end": None}
    ]


def test_list_and_get_internal_library_documents(monkeypatch):
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "test-token")
    client = TestClient(create_app(document_library=_Library()))

    listed = client.get(
        "/v1/library/internal-documents?perm_tag=内部",
        headers={"X-Internal-Token": "test-token"},
    )
    detail = client.get(
        "/v1/library/internal-documents/IV1?perm_tag=内部",
        headers={"X-Internal-Token": "test-token"},
    )

    assert listed.status_code == 200
    assert listed.json()[0]["doc_version_id"] == "IV1"
    assert detail.status_code == 200
    assert detail.json()["clauses"][0]["text"] == "依据《证券法》制定本办法"


def test_check_internal_reference_versions_uses_selected_library_document(monkeypatch):
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "test-token")
    client = TestClient(create_app(document_library=_Library()))

    response = client.post(
        "/v1/internal-reference-version-check",
        headers={"X-Internal-Token": "test-token"},
        json={
            "doc_version_id": "IV1",
            "perm_tags": ["内部"],
            "effective_from": "2024-01-01",
            "effective_to": "2026-12-31",
        },
    )

    assert response.status_code == 200
    assert response.json()["compareType"] == "internal_to_external"


def test_compare_library_versions_returns_structured_clause_changes(monkeypatch):
    monkeypatch.setenv("AUDIT_AI_INTERNAL_TOKEN", "test-token")
    client = TestClient(create_app(document_library=_Library()))

    response = client.post(
        "/v1/library/version-diff",
        headers={"X-Internal-Token": "test-token"},
        json={"new_doc_version_id": "V2", "old_doc_version_id": "V1", "perm_tags": ["内部"]},
    )

    assert response.status_code == 200
    assert response.json()["metrics"] == {"added": 1, "removed": 0, "changed": 1, "moved": 0, "total": 2}
    assert response.json()["rows"][0]["clause_path"] == "第二条"


def _body() -> dict:
    return {
        "object_key": "upload/U1/外规.pdf",
        "upload_id": "U1",
        "filename": "外规.pdf",
        "corpus_hint": "external",
    }


def test_process_document_returns_artifact_metadata(monkeypatch):
    client, processor = _client(monkeypatch)

    response = client.post(
        "/v1/documents:process",
        headers={"X-Internal-Token": "test-token"},
        json=_body(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "upload_id": "U1",
        "artifact_key": "artifact/U1.json",
        "title": "测试外规",
        "page_count": 2,
        "chunk_count": 1,
        "chunk_types": ["clause"],
        "status": "completed",
    }
    assert len(processor.calls) == 1
    assert processor.calls[0].corpus_hint == "external"


def test_process_document_requires_internal_token(monkeypatch):
    client, processor = _client(monkeypatch)

    response = client.post("/v1/documents:process", json=_body())

    assert response.status_code == 401
    assert response.json() == {"error": {"code": "B104", "message": "内部令牌无效"}}
    assert processor.calls == []


def test_process_document_rejects_object_key_not_bound_to_upload(monkeypatch):
    client, processor = _client(monkeypatch)
    body = _body()
    body["object_key"] = "upload/OTHER/外规.pdf"

    response = client.post(
        "/v1/documents:process",
        headers={"X-Internal-Token": "test-token"},
        json=body,
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert processor.calls == []


def test_process_document_maps_unsupported_type(monkeypatch):
    client, _ = _client(monkeypatch, _FailingProcessor(UnsupportedUploadType("secret detail")))

    response = client.post(
        "/v1/documents:process",
        headers={"X-Internal-Token": "test-token"},
        json=_body(),
    )

    assert response.status_code == 415
    assert response.json() == {"error": {"code": "B106", "message": "不支持的文档类型"}}
    assert "secret detail" not in response.text


def test_process_document_maps_missing_object(monkeypatch):
    client, _ = _client(monkeypatch, _FailingProcessor(FileNotFoundError("private path")))

    response = client.post(
        "/v1/documents:process",
        headers={"X-Internal-Token": "test-token"},
        json=_body(),
    )

    assert response.status_code == 422
    assert response.json() == {"error": {"code": "B108", "message": "上传文件不存在"}}
    assert "private path" not in response.text


def test_process_document_maps_oversized_object(monkeypatch):
    client, _ = _client(monkeypatch, _FailingProcessor(UploadTooLarge("private size")))

    response = client.post(
        "/v1/documents:process",
        headers={"X-Internal-Token": "test-token"},
        json=_body(),
    )

    assert response.status_code == 413
    assert response.json() == {"error": {"code": "B107", "message": "文档大小超过 50MB"}}
    assert "private size" not in response.text


def test_process_document_does_not_leak_parse_failure(monkeypatch):
    client, _ = _client(monkeypatch, _FailingProcessor(UploadParseFailed("parser secret")))

    response = client.post(
        "/v1/documents:process",
        headers={"X-Internal-Token": "test-token"},
        json=_body(),
    )

    assert response.status_code == 500
    assert response.json() == {"error": {"code": "B109", "message": "文档解析失败"}}
    assert "parser secret" not in response.text
