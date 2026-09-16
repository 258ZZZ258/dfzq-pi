"""§5.5 重排接缝:Protocol + demo 默认(none passthrough)+ 本地 bge-reranker + 远程 api + factory。

镜像 ``llm/client.py`` / ``embedding_client`` 接缝。``none`` **默认** = passthrough(保 RRF 序,
``rerank=none`` byte 等价);``bge`` = 本地 ``FlagReranker`` 懒载(同 BGE-M3,首次 rerank 时载);
``api`` = Jina/Cohere 风远程 ``/rerank`` 端点(甲方内网 BGE-reranker 网关对齐)。候选按 ``.text``
做 cross-encoder 打分。加载/调用失败**抛、不静默退化 none**(避免误以为重排了)。
模块级零 pipeline 导入(候选按 ``.text`` 鸭子类型,不引 ``Candidate``)。
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

import httpx


@runtime_checkable
class RerankerClient(Protocol):
    """重排接口:``rerank(query, candidates) -> 重排后 candidates``(候选需带 ``.text``)。

    ``rerank_scored`` 附**相关性绝对分** → ``[(cand, score|None)]``(重排序;
    ``none`` 无打分器→全 None)。候选鸭子类型(不引 ``Candidate``);分数写回由 ``Retriever`` 负责。
    """

    def rerank(self, query: str, candidates: list) -> list: ...

    def rerank_scored(self, query: str, candidates: list) -> list: ...


class NoneReranker:
    """passthrough:保留入参(RRF)序 → ``rerank=none`` byte 等价(demo 默认)。"""

    def rerank(self, query: str, candidates: list) -> list:
        return candidates

    def rerank_scored(self, query: str, candidates: list) -> list:
        return [(c, None) for c in candidates]  # 无打分器 → 无绝对分


class BGEReranker:
    """本地 bge-reranker-v2-m3(XLM-RoBERTa cross-encoder,懒载;同 BGE-M3 离线,绝不联网)。

    经 ``transformers`` 直载(``AutoModelForSequenceClassification``)打 query×doc 相关性 logit——
    **不走** ``FlagEmbedding.FlagReranker``(其在 transformers 5.x 调已移除的
    ``tokenizer.prepare_for_model``,见 devlog)。``_scores`` 为打分接缝(单测可 mock,免载模型)。
    """

    def __init__(self, model: str) -> None:
        self._model_name = model
        self._loaded: Any = None  # (model, tokenizer),懒载

    def _load(self) -> Any:
        if self._loaded is None:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            # 本地离线契约(SPEC §8 SC6):local_files_only=True 强制只读本地缓存/路径,
            # **绝不联网下载**;模型不在本地 → from_pretrained 抛(fail closed,不静默退化 none)。
            tok = AutoTokenizer.from_pretrained(self._model_name, local_files_only=True)
            mdl = AutoModelForSequenceClassification.from_pretrained(
                self._model_name, local_files_only=True
            )
            mdl.eval()
            self._loaded = (mdl, tok)
        return self._loaded

    def _scores(self, query: str, texts: list[str]) -> list[float]:
        """query×doc cross-encoder 相关性 logit(越大越相关)。打分接缝,单测 mock 之。"""
        import torch

        mdl, tok = self._load()
        with torch.no_grad():
            inp = tok(
                [[query, t] for t in texts],
                padding=True, truncation=True, max_length=512, return_tensors="pt",
            )
            return mdl(**inp).logits.view(-1).tolist()

    def rerank(self, query: str, candidates: list) -> list:
        return [c for c, _ in self.rerank_scored(query, candidates)]

    def rerank_scored(self, query: str, candidates: list) -> list:
        if not candidates:
            return []
        scores = self._scores(query, [getattr(c, "text", None) or "" for c in candidates])
        order = sorted(zip(scores, candidates, strict=True), key=lambda z: z[0], reverse=True)
        return [(c, float(s)) for s, c in order]


class APIReranker:
    """Jina/Cohere 风远程重排端点(``POST {base_url}{path}``,甲方内网 BGE-reranker 网关对齐)。

    请求 ``{model, query, documents:[...], top_n?}`` → ``{results:[{index, relevance_score}]}``。
    按 ``relevance_score`` 降序重排候选(候选按 ``.text`` 取文本);``top_n`` 截断致缺项候选补回
    原序(**不丢候选**,与 ``bge`` 全量重排语义一致)。构造期校验 ``base_url``(fail-fast)。
    ``_rank`` 为打分接缝(单测 monkeypatch ``httpx.post`` 免网络)。
    """

    def __init__(
        self,
        *,
        base_url: str | None,
        model: str,
        api_key: str | None = None,
        path: str = "/rerank",
        top_n: int | None = None,
        timeout: float = 60.0,
    ) -> None:
        if not base_url:
            raise ValueError(
                "rerank_backend=api 需 base_url"
                "(env QUERY_RERANK_BASE_URL 或 [query].rerank_endpoint_base_url)"
            )
        self._url = base_url.rstrip("/") + path
        self._model = model
        self._api_key = api_key
        self._top_n = top_n
        self._timeout = timeout

    def _rank(self, query: str, documents: list[str]) -> list[tuple[int, float]]:
        """→ ``[(index, score)]`` 按 score 降序。HTTP 接缝(单测 mock ``httpx.post``)。"""
        payload: dict = {"model": self._model, "query": query, "documents": documents}
        if self._top_n:
            payload["top_n"] = self._top_n
        headers = {}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        resp = httpx.post(self._url, headers=headers, json=payload, timeout=self._timeout)
        resp.raise_for_status()
        results = resp.json().get("results", [])
        pairs = [(int(r["index"]), float(r["relevance_score"])) for r in results]
        pairs.sort(key=lambda p: p[1], reverse=True)
        return pairs

    def rerank(self, query: str, candidates: list) -> list:
        return [c for c, _ in self.rerank_scored(query, candidates)]

    def rerank_scored(self, query: str, candidates: list) -> list:
        if not candidates:
            return []
        docs = [getattr(c, "text", None) or "" for c in candidates]
        pairs = self._rank(query, docs)
        if not pairs:  # 空结果 → 保原序,不静默丢候选(无分)
            return [(c, None) for c in candidates]
        seen: set[int] = set()
        ordered: list = []
        for i, s in pairs:
            if 0 <= i < len(candidates) and i not in seen:
                ordered.append((candidates[i], s))
                seen.add(i)
        for i, c in enumerate(candidates):  # top_n 截断时未返回的候选补回原序(无分 → None)
            if i not in seen:
                ordered.append((c, None))
        return ordered


def make_reranker(qcfg) -> RerankerClient:
    """按 ``qcfg.rerank_backend``(默认 none)返回实现(同 LLM/embedding factory)。"""
    backend = getattr(qcfg, "rerank_backend", "none")
    if backend == "none":
        return NoneReranker()
    if backend == "bge":
        return BGEReranker(getattr(qcfg, "rerank_model", "BAAI/bge-reranker-v2-m3"))
    if backend == "api":
        return APIReranker(
            base_url=getattr(qcfg, "rerank_endpoint_base_url", None),
            model=getattr(qcfg, "rerank_model", "BAAI/bge-reranker-v2-m3"),
            api_key=getattr(qcfg, "rerank_endpoint_api_key", None),
            path=getattr(qcfg, "rerank_endpoint_path", "/rerank"),
            top_n=getattr(qcfg, "rerank_endpoint_top_n", None),
        )
    raise ValueError(f"未知 QUERY_RERANK_BACKEND: {backend!r}(none | bge | api)")
