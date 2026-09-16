"""POLICY_MCP_AUDIT_LOG 未配置即启动失败。

理由不是洁癖:未配置时 _audit 只写 stderr,而消费方 McpClient **不转发子进程 stderr**
(只读走以防管道堵塞、留一份有界诊断尾巴)⇒ 审计日志到不了服务日志,A6「pi trajectory
与 MCP 侧日志逐条一致」**无从对账**。静默降级成「日志写了但没人看得见」比启动失败糟得多。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from query.mcp import server as server_mod

_REPO_ROOT = Path(__file__).resolve().parents[3]


def test_missing_audit_log_env_fails_startup(monkeypatch):
    monkeypatch.delenv("POLICY_MCP_AUDIT_LOG", raising=False)
    with pytest.raises(RuntimeError) as e:
        server_mod.require_audit_log_path()
    assert "POLICY_MCP_AUDIT_LOG" in str(e.value)


def test_blank_audit_log_env_fails_startup(monkeypatch):
    # 空串与未设置同样致命 —— open("") 抛的是 FileNotFoundError,
    # 而 _audit 把 OSError 吞掉了,于是空串会静默退化成「只写 stderr」。
    monkeypatch.setenv("POLICY_MCP_AUDIT_LOG", "")
    with pytest.raises(RuntimeError):
        server_mod.require_audit_log_path()


def test_configured_audit_log_env_passes(monkeypatch, tmp_path):
    path = tmp_path / "audit.jsonl"
    monkeypatch.setenv("POLICY_MCP_AUDIT_LOG", str(path))
    assert server_mod.require_audit_log_path() == str(path)


def test_clause_ids_include_nested_batch_candidates_for_audit_reconciliation():
    """批量检索的 item 是输入占位，真正回查键在 candidates 内。"""
    assert server_mod._clause_ids_of(
        {
            "items": [
                {"query_index": 0, "candidates": [{"chunk_id": "INT-1"}, {"chunk_id": "INT-2"}]},
                {"query_index": 1, "candidates": [{"chunk_id": "INT-1"}]},
            ]
        }
    ) == ["INT-1", "INT-2"]


# ---------------------------------------------------------------------------
# 真 spawn:above 三条只直接调 require_audit_log_path(),从不经过 main()。
# 那证明的是"校验函数本身对",不证明 main() 第一行真的调用了它 —— 有人把那行删掉,
# 上面的测试丝毫不会翻红(本轮已用手工变异确认:504 passed 不变)。
#
# 这里换成真起 `python -m query.mcp.server` 子进程,把 main() 的调用点本身纳入回归覆盖。
#
# ⚠ 断言钉在 stderr 文本上,不只钉退出码:摘掉 main() 里那行调用后,子进程读到 stdin EOF
# 会从 anyio.run(_main) 干净返回、退出码变成 0 —— 现状下"非零退出码"这一条断言已经够用,
# 但把 stderr 内容也钉上(把失败精确锚定在 require_audit_log_path 的 RuntimeError 上,而不是
# 任何"恰好也非零"的无关失败)是双重保险,防止将来这条子进程在其他路径上意外非零退出时,
# 只看 returncode 的断言会对不该通过的变异误判通过。
#
# 不依赖跨仓 env(不设 PIPELINE_CONFIG_DIR / DFZQ_AUDIT_AI_*):require_audit_log_path()
# 在 anyio.run(_main) 之前就抛,从不会碰到 PG / Milvus 或 pipeline config —— 已用
# `env -i PATH HOME`(比 monkeypatch 更严格的最小环境)手工验证过,子进程在完全没有
# PIPELINE_CONFIG_DIR 的情况下同样精确落在这条 RuntimeError 上,不会先在别处报错。
def _spawn_server_missing_env(
    monkeypatch: pytest.MonkeyPatch, audit_log_value: str | None
) -> subprocess.CompletedProcess[str]:
    monkeypatch.delenv("POLICY_MCP_AUDIT_LOG", raising=False)
    if audit_log_value is not None:
        monkeypatch.setenv("POLICY_MCP_AUDIT_LOG", audit_log_value)
    return subprocess.run(
        [sys.executable, "-m", "query.mcp.server"],
        input="",  # stdin 立即 EOF:即便变异后真起了 stdio server 也不会挂起等待协议消息
        capture_output=True,
        text=True,
        env=dict(os.environ),
        cwd=str(_REPO_ROOT),
        timeout=15,
    )


def test_missing_audit_log_env_fails_startup_subprocess(monkeypatch):
    result = _spawn_server_missing_env(monkeypatch, audit_log_value=None)
    assert result.returncode != 0, f"stderr={result.stderr!r}"
    assert "POLICY_MCP_AUDIT_LOG" in result.stderr
    assert "RuntimeError" in result.stderr


def test_blank_audit_log_env_fails_startup_subprocess(monkeypatch):
    result = _spawn_server_missing_env(monkeypatch, audit_log_value="")
    assert result.returncode != 0, f"stderr={result.stderr!r}"
    assert "POLICY_MCP_AUDIT_LOG" in result.stderr
    assert "RuntimeError" in result.stderr
