"""policy-query-mcp 的授权层。

红线(dfzq-pi 规格 §0):**算在 Java、用在 Python** —— 本模块只解析与转换 Java jCasbin
预计算的授权位,不做任何权限判断;**fail-closed** —— 缺任何一项即拒绝服务,绝不无过滤放行。

本模块是 audit-ai 边界的第三个消费方(前两个是前端会话式 `/api/query/v1/*` 与
`POST /v1/query`),映射与表达式构造**照抄** `query/query/api/routes_boundary.py:133-150`
的 `_build_scope`,不另发明一套。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import os

from query.listing.r4_listing import array_any_expr

#: 边界 corpus_types → Milvus 分区值。照抄 routes_boundary.py:31。
#: ⚠ `query/query/api/service.py` 里有一个**同名但只有两项**的 map(会话式路径用),别拿错。
_CORPUS_MAP = {"internal": "P-INT", "external": "P-EXT", "qa": "P-QA", "case": "P-CASE"}

#: 边界契约的语料类型全集(routes_boundary.py:44-46 的 Literal)。
KNOWN_CORPUS_TYPES = frozenset({*_CORPUS_MAP, "audit_project"})

#: 合法枚举值但 audit-ai 未接入(Milvus schema 无该分区)。**必须与「未授权」分码** ——
#: 合并后调用方分不清该去申请授权、该改请求、还是该等我们接入(对齐 BOUNDARY-v1:51-62)。
UNSUPPORTED_CORPUS_TYPES = frozenset({"audit_project"})


class ScopeError(Exception):
    """业务级拒绝。``code`` 是 JSON-RPC 错误码。

    ⚠ ``message`` **绝不携带可引用的条款正文**(dfzq-pi 规格 §6-1):消费方采集 clause_id 时
    过滤掉 ``isError: true`` 的工具结果,带正文的错误响应会让模型引用一个不在 clauseIds 里的
    id,输出契约的反幻觉校验随即把一次真实检索到的答案判成幻觉。
    """

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class AuthScope:
    perm_tags: list[str] = field(default_factory=list)
    corpus_types: list[str] = field(default_factory=list)
    run_id: str = ""
    tenant_id: str | None = None
    user_id: str | None = None


def parse_auth(arguments: dict) -> AuthScope:
    """从 ``tools/call`` 的 arguments 里取授权层三项。**每次调用都解析**,不缓存到进程上。

    为什么不在启动时注入一次:S3 会按 specId 池化 MCP 进程(dfzq-pi 规格 §3.3/§3.4),
    把 scope 焊死在进程上会让池化后的第二个 run 用到第一个 run 的授权位。

    这三个键不出现在任何工具的 JSON Schema 里 —— 它们由 TS 侧的 MCP adapter 在 schema
    之外注入,agent 既看不见也填不了(规格 §2.3)。
    """
    for key in ("perm_tags", "corpus_types", "run_id"):
        if key not in arguments:
            raise ScopeError(-32000, f"missing authorization scope: {key} is required")

    run_id = arguments["run_id"]
    if not isinstance(run_id, str) or not run_id:
        # 空串会让 per-run 白名单退化成一个全局桶,池化后跨 run 泄漏条款详情。
        raise ScopeError(-32000, "missing authorization scope: run_id must be a non-empty string")

    corpus_types = arguments["corpus_types"]
    if not isinstance(corpus_types, list) or not corpus_types:
        raise ScopeError(
            -32000, "missing authorization scope: corpus_types must be a non-empty array"
        )

    unsupported = [c for c in corpus_types if c in UNSUPPORTED_CORPUS_TYPES]
    if unsupported:
        raise ScopeError(-32602, f"corpus type(s) not yet supported: {', '.join(unsupported)}")
    unknown = [c for c in corpus_types if c not in KNOWN_CORPUS_TYPES]
    if unknown:
        raise ScopeError(-32602, f"unknown corpus type(s): {', '.join(unknown)}")

    perm_tags = arguments["perm_tags"]
    if not isinstance(perm_tags, list):
        raise ScopeError(-32000, "missing authorization scope: perm_tags must be an array")

    # perm_tags 空数组 = 无额外限制。**这是契约明文,不是 fail-open**
    # (routes_boundary.py:39-40 原话:「``perm_tags`` 空数组=无额外限制(契约明文,非 fail-open)」)。
    # 把它「修」成拒绝等于改边界契约 —— 缺键才是拒绝,上面已判。
    tenant_id = arguments.get("tenant_id")
    user_id = arguments.get("user_id")
    if "tenant_id" in arguments or "user_id" in arguments:
        configured_tenant = os.environ.get("AUDIT_AI_TENANT_ID")
        if not configured_tenant or tenant_id != configured_tenant:
            raise ScopeError(-32000, "tenant scope is not configured or does not match this service")
        if not isinstance(user_id, str) or not user_id or not perm_tags:
            raise ScopeError(-32000, "strict authorization requires user_id and non-empty perm_tags")
    # The imported schema is single-tenant and does not index project/owner ACLs.
    # Refuse restrictions we cannot enforce rather than broadening a signed grant.
    if arguments.get("project_id") is not None or arguments.get("owner") is not None:
        raise ScopeError(-32602, "unsupported authorization restriction: project_id or owner")
    return AuthScope(perm_tags=list(perm_tags), corpus_types=list(corpus_types), run_id=run_id, tenant_id=tenant_id, user_id=user_id)


def build_retrieval_scope(auth: AuthScope, options: dict | None = None) -> dict:
    """→ ``Retriever.scoped(**kwargs)`` 的 kwargs。

    红线:**前置过滤** —— 过滤在检索**前**生效(Milvus filter),不是检索后过滤。
    调用方必须把检索包在 ``with retriever.scoped(**this)`` 内。

    照抄 routes_boundary._build_scope:``audit_project`` 已在 ``parse_auth`` 拒掉,
    这里不再重复判。
    """
    opts = options or {}
    return {
        "corpora": tuple(_CORPUS_MAP[c] for c in auth.corpus_types),
        # 空 perm_tags = 无额外限制(契约);非空走 r4_listing 的加固构造
        # (白名单字段 + json 转义)。**绝不手拼字符串** —— 那个白名单含 perm_tag,
        # 手拼等于绕过注入防线。
        "extra_expr": array_any_expr("perm_tag", list(auth.perm_tags)) if auth.perm_tags else None,
        # None ⇒ 用 qcfg 的默认。臆造一个数值会悄悄改变检索行为。
        "topk": opts.get("topK"),
        "include_superseded": bool(opts.get("includeSuperseded", False)),
    }
