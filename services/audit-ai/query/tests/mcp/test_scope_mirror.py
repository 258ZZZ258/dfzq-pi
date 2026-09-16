"""A4 权限不越界的判别性构造(dfzq-pi 规格-制度查询验收 §3.1)。

❌ 跑正常问题看 basis[] 里没有越界项 —— 可能本来就没命中,零区分力。
✅ 镜像构造:真语料 50 篇**全是 external**,所以「授权 internal ⇒ 零命中」与
   「授权 external ⇒ 命中」两条互为对照,不必灌任何语料。

**两条缺一不可**:只有第 2 条不能排除「检索本来就坏了」,只有第 1 条不能排除
「过滤根本没生效」。
"""

from __future__ import annotations

import os

import pytest

from query.mcp.scope import AuthScope
from query.mcp.session import RunRegistry
from query.mcp.tools import search_policy

pytestmark = pytest.mark.skipif(
    os.environ.get("AUDIT_AI_INTEGRATION_TESTS") != "1" or not os.environ.get("PIPELINE_CONFIG_DIR"),
    reason="需要显式AUDIT_AI_INTEGRATION_TESTS=1和可用PIPELINE_CONFIG_DIR；不属于离线测试",
)

QUERY = "证券公司 客户 账户 开立 管理"

#: Step 0 实测的取值形态。`Candidate.corpus_type` 直接取自 Milvus 命中字段
#: (hybrid.py:131),而 scope.py 的 _CORPUS_MAP 拿 "P-EXT" 去做分区过滤 ——
#: 两者是否同形读码定不了,这里填的是**实测值**,不是推断。
#: 实测(2026-08-01,真环境 PG+Milvus):n=8,corpus_type 取值 {"P-EXT"}。
EXPECTED_CORPUS_TYPE = "P-EXT"


@pytest.fixture
def deps():
    # ⚠ Retriever.from_config 吃的是 query.config.load_query_config() 的 qcfg,
    # **不是** pipeline.config.load_config()(server.py:67-69 的真实用法)。
    from query.config import load_query_config
    from query.retrieve.hybrid import Retriever

    return {"retriever": Retriever.from_config(load_query_config()), "registry": RunRegistry()}


def _hits(deps, corpus_types):
    auth = AuthScope(perm_tags=[], corpus_types=corpus_types, run_id="a4-mirror")
    result = search_policy.call(auth, {"query": QUERY}, deps)
    return result["hits"]


def test_authorized_external_retrieves_and_stays_inside_the_scope(deps):
    hits = _hits(deps, ["external"])
    assert len(hits) >= 1, "外规语料 50 篇,零命中说明检索坏了,不是过滤生效"
    assert {h["corpus_type"] for h in hits} == {EXPECTED_CORPUS_TYPE}


def test_authorized_internal_retrieves_nothing(deps):
    # 库里没有 internal 语料。命中非零 = 前置过滤没生效 = 越权。
    assert _hits(deps, ["internal"]) == []
