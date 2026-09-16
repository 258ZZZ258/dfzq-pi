"""配置加载:把所有 ⚠ 可调值收口到 ``config/`` 三文件,返回类型化 ``Settings``。

约定(SPEC 边界):所有 ⚠ 数值禁止硬编码,必须经此处从 config 读。
连接串、嵌入模式、密钥等运行期/敏感值支持 env 覆盖(见 ``_apply_env``)。
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel

# config.py 位于 <repo>/pipeline/pipeline/config.py → parents[2] = <repo>。
# config/ 留 repo 根(非 pipeline 成员目录内):flat 布局下成员目录 pipeline/ 名同 import 包 pipeline,
# 若置于 pipeline/ 内,则 cwd=repo 根在 sys.path 时 pipeline/config 作命名空间包遮蔽 pipeline.config
# 模块(实测 break `python -m alembic`)。故 config/seeds 作 workspace 级置根(决策⑤修订,见 CP-009)。
DEFAULT_CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"


class DbConfig(BaseModel):
    dsn: str


class MilvusConfig(BaseModel):
    host: str
    port: int
    collection: str
    hnsw_m: int
    hnsw_ef_construction: int
    upsert_batch: int  # ⚠ 批量 upsert 条数
    # ── BM25 全文检索参数(CP-012;仅 embedding.sparse_backend="bm25" 生效)──
    bm25_analyzer_type: str = "chinese"  # ⚠ Milvus analyzer(中文 jieba;发文字号切词达标性 T8 验证)
    bm25_k1: float = 1.2  # ⚠ BM25 k1(Milvus 缺省;V0 标定)
    bm25_b: float = 0.75  # ⚠ BM25 b(Milvus 缺省;V0 标定)


class EmbeddingConfig(BaseModel):
    mode: Literal["local", "endpoint"]
    model_name: str
    batch_size: int  # ⚠(endpoint 模式:每请求 input 条数)
    max_length: int  # ⚠(仅 local 分词截断;endpoint 由服务端处理)
    retries: int  # ⚠ 指数退避次数(local/endpoint 共用)
    # 稀疏通道后端(CP-012):bge=BGE-M3 lexical(默认现状)|
    # bm25=Milvus 原生 BM25 | none=纯 dense。env PIPELINE_SPARSE_BACKEND;非法值 fail-fast。
    sparse_backend: Literal["bge", "bm25", "none"] = "bge"
    cache_dir: str | None = None  # HF_HOME(env 注入,离线缓存)
    # ── endpoint 模式(BGE 系远程 dense+sparse 契约;字段/路径可配以适配 TEI/Xinference/vLLM 等)──
    # base_url/api_key 走 env(内网嵌入服务常与 LLM 服务分离:PIPELINE_EMBEDDING_BASE_URL 优先)。
    endpoint_base_url: str | None = None  # OPENAI_BASE_URL / PIPELINE_EMBEDDING_BASE_URL(env)
    endpoint_api_key: str | None = None  # OPENAI_API_KEY / PIPELINE_EMBEDDING_API_KEY(env,绝不入库)
    endpoint_path: str = "/embeddings"  # ⚠ base_url 后拼接路径
    endpoint_model: str | None = None  # ⚠ 请求 model 名(网关注册名);None → 回落 model_name
    endpoint_dense_field: str = "embedding"  # ⚠ 响应逐条 dense 向量字段名
    # ⚠ 响应 sparse 字段名;值兼容 {token_id:权重} dict 或 [{index,value}] 列表(TEI 风)
    endpoint_sparse_field: str = "sparse_embedding"
    endpoint_timeout: float = 60.0  # ⚠ 单请求超时(秒)


class ObjectStoreConfig(BaseModel):
    root: str  # local 后端根目录
    backend: Literal["local", "minio"] = "local"  # env PIPELINE_OBJECT_STORE_BACKEND
    # ── backend=minio(S3 兼容;上传/内网部署)。creds 走 env MINIO_ACCESS_KEY/SECRET_KEY,绝不入库 ──
    minio_endpoint: str | None = None  # env MINIO_ENDPOINT(host:port)
    minio_bucket: str | None = None  # env MINIO_BUCKET
    minio_secure: bool = False  # https?;env MINIO_SECURE


class TogglesConfig(BaseModel):
    # E1 义务预打标(零 LLM 正则)。LLM 富集(E2/L2/case_l2)已整段移除,相关开关随之删除。
    e1_enabled: bool
    auto_confirm_meta_no_conflict: bool = False


class AlignConfig(BaseModel):
    """页码文本对齐参数(规范渲染件 + 文本对齐,见 SPEC《页码锚点机制》)。"""

    header_band_pct: float  # ⚠ 顶部页眉带占页高比例
    footer_band_pct: float  # ⚠ 底部页脚带占页高比例
    fuzzy_threshold: int  # ⚠ rapidfuzz 兜底阈值(0-100)


class ParseConfig(BaseModel):
    scanned_char_per_page_max: int  # ⚠ <此值/页 判扫描件 → 隔离
    parse_timeout_sec: int  # ⚠ 单文档解析超时


class ChunkConfig(BaseModel):
    target_token_min: int  # ⚠
    target_token_max: int  # ⚠
    parent_block_token_max: int  # ⚠ 父块(节级)上限,仅 PG


class QcThresholds(BaseModel):
    """S2 七指标阈值 + 边缘带 ε(全部 ⚠)。"""

    clause_coverage_min: float  # 指标1 条款覆盖率
    clause_continuity_max_gap: int  # 指标2 条号连续性(允许缺口数)
    hierarchy_illegal_max: int  # 指标3 层级合法性(倒挂块数)
    page_anchor_complete_min: float  # 指标4 页码锚点完整率
    table_empty_max: float  # 指标5 空表占比上限
    text_garbled_max: float  # 指标6 非 CJK 乱码占比上限
    ocr_conf_min: float = 0.85  # 指标6 OCR 文档块均值置信度下限(仅 OCR 文档参与;非 OCR 跳过)
    extraction_sufficiency_min: float  # 指标7 抽取充分性
    qa_pair_completeness_min: float = 0.95  # P-QA 专属:问答对完整率(完整对数 ÷ 问标记数)≥
    edge_band_epsilon: float  # 边缘通过带 ε


class VerifyConfig(BaseModel):
    """M2 验证组件阈值(T2 冒烟 / T4 锚点回放),全部 ⚠。"""

    t2_synthetic_query_head_chars: int  # ⚠ T2 合成查询:标题 + 首条款前 N 字
    t2_hit_at: int  # ⚠ T2 命中判定 hit@N
    t4_page_window: int  # ⚠ T4 取页窗口:page_start/page_end 各 ±N 页
    t4_fuzzy_threshold: int  # ⚠ T4 精确未中的 rapidfuzz partial_ratio 阈值(0-100)


class ObligationConfig(BaseModel):
    """M3 E1 义务预打标词表 + 阈值(零 LLM 正则),全部 ⚠。"""

    markers: list[str]  # ⚠ 强义务情态词(整词命中即义务)
    bare_chars: list[str]  # ⚠ 单字情态词(应/须),带前缀排除(空=只认整词 markers)
    exclusions: list[str]  # ⚠ 前缀歧义排除(相应/对应… X应、无须/毋须 X须)
    accuracy_threshold: float  # ⚠ V8 门:golden set precision 与 recall 各须 ≥ 此值


class ProfileConfig(BaseModel):
    """per-profile 档案(CP-010 T1 配置缝:QC 启用集/阈值覆盖/案例引用来源进 yaml)。

    qc_indicators=None(旧 yaml 形态)→ 回退 indicators._DEFAULT_PROFILE_INDICATORS 硬编码默认,
    保证既有四 profile 与配置缺失场景行为零变更(对拍测试 test_preseg_profiles_seam)。
    """

    qc_indicators: list[str] | None = None  # S2 启用集(INDICATOR_REGISTRY 名);None=硬编码默认
    qc_threshold_overrides: dict[str, float] = {}  # 对 QcThresholds 字段的 per-profile 覆盖
    # 案例引用来源:structured(预切块直装)| 其它值=自建通道规则抽取(零 LLM;case_l2 已移除)
    case_ref_source: str = "rule"


class Settings(BaseModel):
    db: DbConfig
    milvus: MilvusConfig
    embedding: EmbeddingConfig
    object_store: ObjectStoreConfig
    toggles: TogglesConfig
    align: AlignConfig
    parse: ParseConfig
    chunk: ChunkConfig
    qc: QcThresholds
    verify: VerifyConfig
    obligation: ObligationConfig
    profiles: dict[str, ProfileConfig]
    config_dir: Path


def _apply_env(raw: dict) -> None:
    """对连接串/嵌入模式/密钥等做 env 覆盖(就地修改 raw)。"""
    env = os.environ
    if "PIPELINE_DB_DSN" in env:
        raw["db"]["dsn"] = env["PIPELINE_DB_DSN"]
    if "PIPELINE_MILVUS_HOST" in env:
        raw["milvus"]["host"] = env["PIPELINE_MILVUS_HOST"]
    emb = raw["embedding"]
    if "PIPELINE_EMBEDDING_MODE" in env:
        emb["mode"] = env["PIPELINE_EMBEDDING_MODE"]
    if "PIPELINE_SPARSE_BACKEND" in env:  # 稀疏通道后端(CP-012:bge|bm25|none)
        emb["sparse_backend"] = env["PIPELINE_SPARSE_BACKEND"]
    if "PIPELINE_EMBEDDING_MODEL" in env:  # 指向本地模型目录(离线/镜像下载场景,如信创目标)
        emb["model_name"] = env["PIPELINE_EMBEDDING_MODEL"]
    if "OPENAI_BASE_URL" in env:
        emb["endpoint_base_url"] = env["OPENAI_BASE_URL"]
    if "PIPELINE_EMBEDDING_BASE_URL" in env:  # 专用,优先于 OPENAI_BASE_URL(嵌入服务常独立部署)
        emb["endpoint_base_url"] = env["PIPELINE_EMBEDDING_BASE_URL"]
    if "OPENAI_API_KEY" in env:
        emb["endpoint_api_key"] = env["OPENAI_API_KEY"]
    if "PIPELINE_EMBEDDING_API_KEY" in env:  # 专用嵌入端点 key,优先于 OPENAI_API_KEY(绝不入库)
        emb["endpoint_api_key"] = env["PIPELINE_EMBEDDING_API_KEY"]
    if "PIPELINE_EMBEDDING_ENDPOINT_MODEL" in env:  # 网关注册的嵌入 model 名
        emb["endpoint_model"] = env["PIPELINE_EMBEDDING_ENDPOINT_MODEL"]
    if "HF_HOME" in env:
        emb["cache_dir"] = env["HF_HOME"]
    os_ = raw.setdefault("object_store", {})
    if "PIPELINE_OBJECT_STORE_BACKEND" in env:
        os_["backend"] = env["PIPELINE_OBJECT_STORE_BACKEND"]
    if "MINIO_ENDPOINT" in env:
        os_["minio_endpoint"] = env["MINIO_ENDPOINT"]
    if "MINIO_BUCKET" in env:
        os_["minio_bucket"] = env["MINIO_BUCKET"]
    if "MINIO_SECURE" in env:
        os_["minio_secure"] = env["MINIO_SECURE"]  # "0"/"1" → pydantic bool 强转


def load_config(config_dir: str | os.PathLike | None = None) -> Settings:
    """读取 settings.toml + qc_thresholds.yaml + profiles.yaml,应用 env 覆盖,返回 Settings。

    config_dir 解析优先级:显式参数 > 环境变量 PIPELINE_CONFIG_DIR > 默认 <repo>/config。
    """
    cdir = Path(config_dir) if config_dir else Path(
        os.environ.get("PIPELINE_CONFIG_DIR", DEFAULT_CONFIG_DIR)
    )

    settings_raw = tomllib.loads((cdir / "settings.toml").read_text(encoding="utf-8"))
    qc_raw = yaml.safe_load((cdir / "qc_thresholds.yaml").read_text(encoding="utf-8"))
    obligation_raw = yaml.safe_load((cdir / "obligation.yaml").read_text(encoding="utf-8"))
    profiles_raw = yaml.safe_load((cdir / "profiles.yaml").read_text(encoding="utf-8"))

    _apply_env(settings_raw)

    return Settings(
        db=DbConfig(**settings_raw["db"]),
        milvus=MilvusConfig(**settings_raw["milvus"]),
        embedding=EmbeddingConfig(**settings_raw["embedding"]),
        object_store=ObjectStoreConfig(**settings_raw["object_store"]),
        toggles=TogglesConfig(**settings_raw["toggles"]),
        align=AlignConfig(**settings_raw["align"]),
        parse=ParseConfig(**settings_raw["parse"]),
        chunk=ChunkConfig(**settings_raw["chunk"]),
        qc=QcThresholds(**qc_raw),
        verify=VerifyConfig(**settings_raw["verify"]),
        obligation=ObligationConfig(**obligation_raw),
        profiles={k: ProfileConfig(**v) for k, v in profiles_raw.items()},
        config_dir=cdir,
    )
