"""嵌入客户端:抽象接口 + 本地 BGEM3 实现(dense+sparse 一次产出)+ BGE 系远程 endpoint。

本地用 FlagEmbedding ``BGEM3FlagModel``:一次 ``encode`` 同出 dense(归一,1024 维)+ sparse
(``lexical_weights``,token_id→权重)。模型**懒加载**(首次 embed 时载;首跑从 HF 下载 ~2GB)。
batch_size / max_length / retries 全部从 config(⚠)。指数退避重试编码调用。

``EndpointClient``(``mode=endpoint``):BGE 系远程嵌入端点,一次请求同拿 dense+sparse,保留混合
检索(**非** OpenAI dense-only;甲方内网部署对齐)。请求/响应字段可配(``endpoint_dense_field`` /
``endpoint_sparse_field`` / ``endpoint_path``),适配 TEI/Xinference/vLLM 等常见 BGE serving。摄取
与查询两侧共用 ``from_config`` → 同一 mode 保证向量同空间。

sparse 的 token_id→SPARSE_FLOAT_VECTOR 转换属 C5(milvus_io);本层只产出原始 lexical_weights。
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from pipeline.config import EmbeddingConfig, Settings


@dataclass(frozen=True)
class Embedding:
    dense: list[float]  # 归一稠密向量(BGE-M3 1024 维)
    sparse: dict[str, float]  # lexical_weights:token_id(str)→权重(C5 转 SPARSE_FLOAT_VECTOR)


def _retry(fn: Callable[[], Any], *, retries: int) -> Any:
    """指数退避重试 ``fn()``;末次仍失败则抛最后一次异常。"""
    last: Exception | None = None
    for i in range(max(1, retries)):
        try:
            return fn()
        except Exception as e:  # 重试任何编码失败(OOM/瞬时错误)
            last = e
            if i < retries - 1:
                time.sleep(0.5 * 2**i)
    raise last if last else RuntimeError("retry 未执行")


class EmbeddingClient(ABC):
    """嵌入客户端接口。``embed`` 接收文本列表,返回等长 ``Embedding`` 列表。"""

    @abstractmethod
    def embed(self, texts: list[str]) -> list[Embedding]: ...

    @classmethod
    def from_config(cls, settings: Settings) -> EmbeddingClient:
        cfg = settings.embedding
        return LocalBGEM3Client(cfg) if cfg.mode == "local" else EndpointClient(cfg)


class LocalBGEM3Client(EmbeddingClient):
    def __init__(self, cfg: EmbeddingConfig) -> None:
        self.cfg = cfg
        self._model: Any = None  # 懒加载(避免 import 期加载 ~2GB 模型)

    def _load(self) -> Any:
        if self._model is None:
            from FlagEmbedding import BGEM3FlagModel

            # cache_dir 来自 config(HF_HOME env 或 settings.toml),离线缓存路径;None=用 HF 默认缓存。
            # model_name 为本地绝对目录时 cache_dir 不参与加载(直读该目录),传 None 无害。
            self._model = BGEM3FlagModel(
                self.cfg.model_name, use_fp16=False, cache_dir=self.cfg.cache_dir
            )  # use_fp16=False:CPU 友好
        return self._model

    def embed(self, texts: list[str]) -> list[Embedding]:
        if not texts:
            return []
        model = self._load()
        out = _retry(
            lambda: model.encode(
                texts,
                batch_size=self.cfg.batch_size,
                max_length=self.cfg.max_length,
                return_dense=True,
                return_sparse=True,
                return_colbert_vecs=False,
            ),
            retries=self.cfg.retries,
        )
        dense, sparse = out["dense_vecs"], out["lexical_weights"]
        return [
            Embedding(
                dense=[float(x) for x in dense[i]],
                sparse={str(k): float(v) for k, v in sparse[i].items()},
            )
            for i in range(len(texts))
        ]


def _normalize_sparse(raw: Any) -> dict[str, float]:
    """归一 sparse 到 ``{token_id(str): 权重}``(与 ``Embedding.sparse`` / milvus_io 契约一致)。

    兼容两形态:``{token_id: 权重}`` dict(BGE native / Xinference)与 ``[{index, value}]`` 列表
    (TEI ``/embed_sparse`` 风)。缺失/空 → ``{}``(下游混合查已有 sparse 空 → dense-only 兜底)。
    """
    if not raw:
        return {}
    if isinstance(raw, dict):
        return {str(k): float(v) for k, v in raw.items()}
    if isinstance(raw, list):  # [{"index": int, "value": float}, ...]
        out: dict[str, float] = {}
        for item in raw:
            if isinstance(item, dict) and "index" in item and "value" in item:
                out[str(item["index"])] = float(item["value"])
        return out
    return {}


def _extract_rows(data: Any, n: int) -> list[dict]:
    """从响应取逐条结果(``data`` 或 ``embeddings`` 或裸列表),按 ``index`` 严格对齐、校验条数。

    ``index`` 若出现,必须**每条都有、为整数、且恰构成 0..n-1 完整排列**——否则按序对齐会把向量
    错配到别的文本(静默检索污染)。部分缺 / 非整数 / 重复 / 缺号一律拒绝,绝不静默(Codex)。
    """
    rows = data.get("data") or data.get("embeddings") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise ValueError(f"endpoint 响应无法解析出结果列表:{type(rows).__name__}")
    if len(rows) != n:
        raise ValueError(f"endpoint 响应条数不符:请求 {n} 得 {len(rows)}")
    has_index = [isinstance(r, dict) and "index" in r for r in rows]
    if any(has_index):
        if not all(has_index) or not all(
            isinstance(r["index"], int) and not isinstance(r["index"], bool) for r in rows
        ):
            raise ValueError("endpoint 响应部分条目缺 index 或非整数,无法可靠对齐输入序")
        if sorted(r["index"] for r in rows) != list(range(n)):
            raise ValueError(f"endpoint 响应 index 非 0..{n - 1} 完整排列(乱序/重复/缺号)")
        rows = sorted(rows, key=lambda r: r["index"])  # 服务端乱序 → 按 index 恢复入参序
    return rows


class EndpointClient(EmbeddingClient):
    """BGE 系远程嵌入端点(dense+sparse 一次产出;字段/路径可配)。

    请求 ``POST {base_url}{endpoint_path}``:``{model, input:[...], return_dense, return_sparse}``。
    逐条取 ``endpoint_dense_field`` 为 dense、``endpoint_sparse_field`` 为 sparse(两形态归一)→
    映射现有 ``Embedding`` → 下游 milvus_io / 混合检索 / 冷备零改。

    **构造即失败(fail-fast)**:缺 ``endpoint_base_url`` 即抛(``from_config`` 一构造就在
    search / ingest 命令开头清晰失败,而非埋到 S5 嵌入才崩)。``retries`` 复用指数退避;
    ``batch_size`` 分批(每请求 input 条数)。``_post`` 为 HTTP 接缝(单测 monkeypatch)。
    """

    def __init__(self, cfg: EmbeddingConfig) -> None:
        if not cfg.endpoint_base_url:
            raise ValueError(
                "embedding.mode=endpoint 需 endpoint_base_url"
                "(env PIPELINE_EMBEDDING_BASE_URL / OPENAI_BASE_URL 或 settings.toml 配置)"
            )
        self.cfg = cfg
        self._url = cfg.endpoint_base_url.rstrip("/") + cfg.endpoint_path
        self._model = cfg.endpoint_model or cfg.model_name

    def _post(self, payload: dict) -> Any:
        headers = {}
        if self.cfg.endpoint_api_key:
            headers["Authorization"] = f"Bearer {self.cfg.endpoint_api_key}"
        resp = httpx.post(
            self._url, headers=headers, json=payload, timeout=self.cfg.endpoint_timeout
        )
        resp.raise_for_status()
        return resp.json()

    def _embed_batch(self, batch: list[str]) -> list[Embedding]:
        payload = {
            "model": self._model,
            "input": batch,
            "return_dense": True,
            "return_sparse": True,
        }
        data = _retry(lambda: self._post(payload), retries=self.cfg.retries)
        rows = _extract_rows(data, len(batch))
        out: list[Embedding] = []
        for r in rows:
            dense = r.get(self.cfg.endpoint_dense_field)
            if dense is None:
                raise ValueError(f"endpoint 响应缺 dense 字段 {self.cfg.endpoint_dense_field!r}")
            out.append(
                Embedding(
                    dense=[float(x) for x in dense],
                    sparse=_normalize_sparse(r.get(self.cfg.endpoint_sparse_field)),
                )
            )
        return out

    def embed(self, texts: list[str]) -> list[Embedding]:
        if not texts:
            return []
        bs = max(1, self.cfg.batch_size)
        out: list[Embedding] = []
        for i in range(0, len(texts), bs):
            out.extend(self._embed_batch(texts[i : i + bs]))
        return out
