"""policy-query-mcp 的 stdio 入口。

跑法:``python -m query.mcp.server``(cwd 为本仓根;PG/Milvus 连接按 audit-ai 既有 config 读)。

定位:audit-ai 边界的**第三个消费方**(前两个是前端会话式 ``/api/query/v1/*`` 与
``POST /v1/query``)。与 ``api/routes_boundary.py`` 同层 —— 薄壳 + scope 注入,不改 AI 内核。

⚠ 协议版本是跨仓耦合点:消费方 dfzq-pi 的 MCP client 硬编码 ``protocolVersion``
``"2024-11-05"``,而它正是本 SDK ``HANDSHAKE_PROTOCOL_VERSIONS`` 里最老的一个。
dfzq-pi 侧有 ``test/cross-repo-handshake.test.ts`` 钉住这条。
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any

import anyio
import mcp.types as t
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from query.mcp import scope as scope_mod
from query.mcp.session import RunRegistry
from query.mcp.tools import (
    assess_sufficiency,
    enumerate_clauses,
    get_clause_detail,
    list_internal_obligations,
    resolve_source_law,
    retrieve_external_candidates_batch,
    retrieve_internal_candidates_batch,
    search_cases,
    search_policy,
)

#: 工具面 = T1/T2/T3/T4/T7。T5(零多版本数据)与 T8(底层无判定能力)本轮不做,
#: T6 stats_query 待 R2/R3 完成 —— 见 dfzq-pi 规格 §3.2.0。
_TOOL_MODULES = (
    search_policy,
    search_cases,
    enumerate_clauses,
    get_clause_detail,
    assess_sufficiency,
    list_internal_obligations,
    retrieve_internal_candidates_batch,
    retrieve_external_candidates_batch,
    resolve_source_law,
)
_BY_NAME = {m.TOOL.name: m for m in _TOOL_MODULES}

_DEPS: dict[str, Any] | None = None


def _deps() -> dict[str, Any]:
    """进程级依赖,惰性建一次。

    照抄 ``query/query/api/service.py:204-228`` 的 ``QueryService.from_config()``,
    不自己发明连接串。

    这里**只放无 per-run 状态的东西**:``Retriever`` / ``PgIO`` 跨 run 复用是安全的,
    per-run 的只有 scope(每次 tools/call 解析)与 ``RunRegistry``(按 run_id 分桶)。
    """
    global _DEPS
    if _DEPS is None:
        from pipeline.config import load_config
        from pipeline.index.pg_io import PgIO
        from query.config import load_query_config
        from query.generate.anchors import fetch_anchors, fetch_parent_text, fetch_texts
        from query.retrieve.hybrid import Retriever

        qcfg = load_query_config()
        _DEPS = {
            "retriever": Retriever.from_config(qcfg),
            "pg": PgIO.from_config(load_config()),
            "registry": RunRegistry(),
            "qcfg": qcfg,
            # 回查函数经 deps 注入而非在工具里直接 import:工具因此可以用假 pg 单测,
            # 也让「T4 用的到底是 fetch_texts 还是 fetch_parent_text」在测试里可断言。
            "fetch_anchors": fetch_anchors,
            "fetch_texts": fetch_texts,
            "fetch_parent_text": fetch_parent_text,
        }
    return _DEPS


def _error(code: int, message: str) -> t.CallToolResult:
    """业务级错误。

    ⚠ **绝不携带可引用的条款正文**(dfzq-pi 规格 §6-1)。消费方采集 clause_id 时过滤掉
    ``isError: true`` 的工具结果 —— 带正文的错误响应会让模型看见并引用一个不在 clauseIds
    里的 id,输出契约的反幻觉校验随即把一次**真实检索到、真实引用**的答案判成幻觉。
    """
    return t.CallToolResult(
        content=[
            t.TextContent(
                type="text",
                text=json.dumps({"code": code, "message": message}, ensure_ascii=False),
            )
        ],
        is_error=True,
    )


async def _on_list_tools(ctx, params) -> t.ListToolsResult:  # noqa: ARG001
    return t.ListToolsResult(tools=[m.TOOL for m in _TOOL_MODULES])


def _audit(run_id: str, tool: str, outcome: str, **extra: Any) -> None:
    """每次 tools/call 落一行审计日志。

    **对账凭证**(dfzq-pi 规格 §8.1 的 A6:「pi trajectory 与 MCP 侧日志逐条一致」)。

    落点有两个,都要:
    - **stderr** —— 人工诊断用。⚠ 消费方 `McpClient` **不转发子进程 stderr**,它只是读走
      以防管道堵塞、并留一份有界的诊断尾巴(client.ts)。所以 stderr 到不了服务日志,
      **不能作为对账凭证**(第三次真跑才发现:审计日志写了,serve.log 里一行没有)。
    - **`POLICY_MCP_AUDIT_LOG` 指定的文件** —— 真正的对账落点。未配置则只写 stderr。
      机制与消费方既有的 `EVAL_TASK_LOG` 同构。

    ⚠ **只记标识,不记内容**:`clause_id` 是回查键(本来就要回给模型),而条款正文、
    检索词都不落 —— 日志文件的访问控制比 MCP 通道弱,不该成为绕过授权的读取面。
    参数只记**键名**,不记值。
    """
    record = {"run_id": run_id, "tool": tool, "outcome": outcome, **extra}
    line = json.dumps(record, ensure_ascii=False)
    print(line, file=sys.stderr)
    sys.stderr.flush()
    path = os.environ.get("POLICY_MCP_AUDIT_LOG")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            # 观测是尽力而为的,写失败不该打断本该完成的工具调用。
            pass


async def _on_call_tool(ctx, params: t.CallToolRequestParams) -> t.CallToolResult:  # noqa: ARG001
    """工具分发。

    ``call()`` 是同步的:被包的 ``Retriever`` / PG 客户端全是同步客户端,``async def``
    只会包一层什么都不 await 的壳。stdio 传输本身也是串行的,当前一个进程服务一个 run。
    (S3 池化后若一进程服务多个并发 run,这会把它们串行化 —— 那时再议。)
    """
    arguments = params.arguments or {}
    # 授权位缺失时也要能对账,所以 run_id 单独取一次(取不到就记 "-")。
    run_id = arguments.get("run_id") if isinstance(arguments.get("run_id"), str) else "-"
    module = _BY_NAME.get(params.name)
    if module is None:
        _audit(run_id or "-", params.name, "unknown_tool")
        return _error(-32602, f"unknown tool: {params.name}")
    try:
        # fail-closed:授权层先判,任何一项缺失都不进业务逻辑。
        auth = scope_mod.parse_auth(arguments)
        result = module.call(auth, arguments, _deps())
    except scope_mod.ScopeError as exc:
        _audit(run_id or "-", params.name, "rejected", code=exc.code)
        return _error(exc.code, exc.message)
    except Exception as exc:  # noqa: BLE001
        # 下游(PG / Milvus / embedding)不可用。
        #
        # **回给模型的只有异常类型名**,不含 message —— 异常文本可能夹带被查询的内容,
        # 而带正文的 isError 响应会触发反幻觉误判(dfzq-pi 规格 §6-1)。
        #
        # **但完整堆栈必须写 stderr**:消费方 McpClient 会捕获它并在诊断里回显
        # (client.ts 的 stderrSummary)。第一次真跑就栽在这上面 —— 当时只回类型名、
        # stderr 也不写,`ModuleNotFoundError` 这条本身完全无害的信息被藏掉,
        # 只能靠手工复现最小 env 才诊断出是 fork venv 缺 FlagEmbedding。
        # 安全边界是「回给模型的内容」,不是「运维能不能看见」,两者不该一起收紧。
        _audit(run_id or "-", params.name, "upstream_failure", error=type(exc).__name__)
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return _error(-32000, f"upstream failure in {params.name}: {type(exc).__name__}")

    _audit(
        run_id or "-",
        params.name,
        "ok",
        param_keys=sorted(k for k in arguments if k not in ("perm_tags", "corpus_types", "run_id")),
        clause_ids=_clause_ids_of(result),
    )
    return t.CallToolResult(
        content=[t.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]
    )


def _clause_ids_of(result: dict) -> list[str]:
    """从工具返回里抽 clause_id,供 A6 对账。形状随工具而异,抽不到就空。

    ``retrieve_internal_candidates_batch`` 的权威回查键位于
    ``items[].candidates[]``。不能只看外层 item：它本身是输入条款的占位，
    没有 ``chunk_id``，会让一次真实命中的批量检索在审计中伪装成空结果。
    """
    ids: list[str] = []

    def collect(rows: object) -> None:
        if not isinstance(rows, list):
            return
        for row in rows:
            if not isinstance(row, dict):
                continue
            clause_id = row.get("clause_id", row.get("chunk_id"))
            if isinstance(clause_id, str):
                ids.append(clause_id)
            # 批量候选的回查键是嵌套的；其他工具没有 candidates 时这是无操作。
            collect(row.get("candidates"))

    for key in ("hits", "items", "cases"):
        collect(result.get(key))
    return list(dict.fromkeys(ids))


def require_audit_log_path() -> str:
    """A6 的对账落点必须配好才允许起服务。

    未配置时 ``_audit`` 只写 stderr,而消费方 ``McpClient`` **不转发子进程 stderr** ——
    它只读走以防管道堵塞、并留一份有界的诊断尾巴。所以「未配置」的真实后果不是
    「日志少一份」,而是 **A6 完全无从对账**,且失败是静默的。
    """
    path = os.environ.get("POLICY_MCP_AUDIT_LOG")
    if not path:
        raise RuntimeError(
            "POLICY_MCP_AUDIT_LOG is required: without it the audit trail only reaches stderr, "
            "which McpClient does not forward, and A6 reconciliation becomes impossible."
        )
    return path


def build_server() -> Server:
    return Server(
        "policy-query",
        version="0.1.0",
        instructions="制度查询:带授权范围的条款检索与权威详情回查。",
        on_list_tools=_on_list_tools,
        on_call_tool=_on_call_tool,
    )


async def _main() -> None:
    server = build_server()
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def main() -> None:
    require_audit_log_path()
    anyio.run(_main)


if __name__ == "__main__":
    main()
