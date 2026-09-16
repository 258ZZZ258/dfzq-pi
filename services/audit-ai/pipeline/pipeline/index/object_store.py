"""ObjectStore:本地文件系统实现 + MinIO(S3)后端;二者同 key 布局、同高层接口。

key 布局:
- ``raw/{corpus_type}/{batch_id}/{doc_version_id}.{ext}`` —— 原件,**写一次**(原件留证)
- ``rendition/{doc_version_id}.pdf``                       —— 规范渲染件,**写一次**(reprocess 复用)
- ``ir/{doc_version_id}.json``                             —— IR,可重写(fix/reprocess)
- ``artifact/{upload_id}.json``                            —— 对话上传中间产物,幂等覆盖(ondemand)

写一次语义:put 时若 key 已存在则**不覆盖**、复用既有(使重复 ingest / reprocess 幂等安全)。

后端选择 ``ObjectStore.from_config``:``object_store.backend``(local | minio)。MinIO 后端
(``MinioObjectStore``)只覆盖 3 个 IO 原语(``get`` / ``exists`` / ``_write``),继承全部 key 布局与
高层方法;minio SDK **懒导入**(仅 backend=minio 时需装),creds 走 env 绝不入库。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from common.ir import IRDocument
from pipeline.config import ObjectStoreConfig, Settings


class ObjectTooLargeError(ValueError):
    """Object exceeds the caller's bounded-read limit."""


class ObjectStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    @classmethod
    def from_config(cls, settings: Settings) -> ObjectStore:
        oc = settings.object_store
        if oc.backend == "minio":
            return MinioObjectStore.from_env(oc)
        return cls(oc.root)

    # ── key 布局 ──────────────────────────────────────────────
    @staticmethod
    def raw_key(corpus_type: str, batch_id: str, doc_version_id: str, ext: str) -> str:
        return f"raw/{corpus_type}/{batch_id}/{doc_version_id}.{ext.lstrip('.')}"

    @staticmethod
    def rendition_key(doc_version_id: str) -> str:
        return f"rendition/{doc_version_id}.pdf"

    @staticmethod
    def ir_key(doc_version_id: str) -> str:
        return f"ir/{doc_version_id}.json"

    @staticmethod
    def artifact_key(upload_id: str) -> str:
        # 对话上传中间产物(context-first,ondemand.process);见 SPEC-UPLOAD-PROCESSING §5.2
        return f"artifact/{upload_id}.json"

    # ── 通用 ──────────────────────────────────────────────────
    def _path(self, key: str) -> Path:
        # 防路径穿越(Codex):key 恒为 root 下相对路径。绝对 key(``root / 绝对`` 会丢弃 root)
        # 或含 .. 逃逸 → 解析后不在 root 内 → 拒绝。外部可控入参(process_upload 的 object_key /
        # upload_id)不得读写 root 外。MinIO 后端不走本方法(直接用 client + key),仅约束本地 FS 后端。
        p = (self.root / key).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError(f"ObjectStore key 越界(拒绝绝对路径 / .. 逃逸 root):{key!r}")
        return p

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def get(self, key: str, *, max_bytes: int | None = None) -> bytes:
        path = self._path(key)
        if max_bytes is None:
            return path.read_bytes()
        with path.open("rb") as handle:
            data = handle.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ObjectTooLargeError(f"object exceeds {max_bytes} bytes")
        return data

    def _write(self, key: str, data: bytes, *, write_once: bool) -> str:
        p = self._path(key)
        if write_once and p.exists():
            return key  # 写一次:不覆盖,复用既有
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return key

    # ── 三类产物 ──────────────────────────────────────────────
    def put_raw(
        self, corpus_type: str, batch_id: str, doc_version_id: str, ext: str, data: bytes
    ) -> str:
        return self._write(
            self.raw_key(corpus_type, batch_id, doc_version_id, ext), data, write_once=True
        )

    def put_rendition(self, doc_version_id: str, data: bytes) -> str:
        return self._write(self.rendition_key(doc_version_id), data, write_once=True)

    def exists_rendition(self, doc_version_id: str) -> bool:
        return self.exists(self.rendition_key(doc_version_id))

    def get_rendition(self, doc_version_id: str) -> bytes:
        return self.get(self.rendition_key(doc_version_id))

    def put_ir(self, ir: IRDocument) -> str:
        # IR 可重写(人工 fix 编辑 / reprocess 重解析)
        return self._write(
            self.ir_key(ir.doc_version_id), ir.model_dump_json().encode("utf-8"), write_once=False
        )

    def load_ir(self, doc_version_id: str) -> IRDocument:
        return IRDocument.model_validate_json(self.get(self.ir_key(doc_version_id)).decode("utf-8"))

    # ── 对话上传中间产物 ──────────────────────────────────────
    def put_artifact(self, upload_id: str, data: bytes) -> str:
        # 幂等覆盖:同 upload_id 重跑覆盖(context-first 无版本语义)
        return self._write(self.artifact_key(upload_id), data, write_once=False)

    def get_artifact(self, upload_id: str) -> bytes:
        return self.get(self.artifact_key(upload_id))


class MinioObjectStore(ObjectStore):
    """MinIO(S3 兼容)后端:继承 ObjectStore 全部 key 布局 + 高层方法,只覆盖 3 个 IO 原语。

    minio SDK **懒导入**(仅 backend=minio 时需装);``__init__`` 收注入好的 client(便于单测注入
    fake);``from_env`` 从 config + env 建真 client(creds 走 env,绝不入库)。
    """

    def __init__(self, client: Any, bucket: str) -> None:
        # 不调用 super().__init__(无本地 root);只覆盖 IO 原语,继承 key 布局 + 高层方法
        self._client = client
        self._bucket = bucket

    @classmethod
    def from_env(cls, cfg: ObjectStoreConfig) -> MinioObjectStore:
        import os

        endpoint = cfg.minio_endpoint or os.environ.get("MINIO_ENDPOINT")
        bucket = cfg.minio_bucket or os.environ.get("MINIO_BUCKET")
        if not endpoint or not bucket:  # 先校验(不触发 minio 导入)→ 缺配置清晰 fail-fast
            raise ValueError(
                "object_store.backend=minio 需 minio_endpoint + minio_bucket"
                "(env MINIO_ENDPOINT / MINIO_BUCKET)"
            )
        from minio import Minio  # 懒导入:仅真建 client 时需装

        client = Minio(
            endpoint,
            access_key=os.environ.get("MINIO_ACCESS_KEY"),
            secret_key=os.environ.get("MINIO_SECRET_KEY"),
            secure=cfg.minio_secure,
        )
        return cls(client, bucket)

    def exists(self, key: str) -> bool:
        try:
            self._client.stat_object(self._bucket, key)
            return True
        except Exception as e:
            # 仅"对象不存在"(S3 NoSuchKey)视为 False;鉴权/桶不存在/网络等错误**上抛**——
            # 否则 write_once=True 会把这些错误误判成"不存在"并 put_object,
            # 破坏写一次语义(Codex F2)。
            if getattr(e, "code", None) == "NoSuchKey":
                return False
            raise

    def get(self, key: str, *, max_bytes: int | None = None) -> bytes:
        resp = self._client.get_object(self._bucket, key)
        try:
            data = resp.read() if max_bytes is None else resp.read(max_bytes + 1)
            if max_bytes is not None and len(data) > max_bytes:
                raise ObjectTooLargeError(f"object exceeds {max_bytes} bytes")
            return data
        finally:
            resp.close()
            resp.release_conn()

    def _write(self, key: str, data: bytes, *, write_once: bool) -> str:
        import io

        if write_once and self.exists(key):
            return key
        self._client.put_object(self._bucket, key, io.BytesIO(data), length=len(data))
        return key
