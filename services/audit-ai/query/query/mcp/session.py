"""per-run 的检索/取证记录。

两个用途,一个是权限、一个是观测,**不要混淆**:

1. **权限**(`allowed`):T4 `get_clause_detail` / T5 `diff_policy_versions` 只允许取本 run
   检索过的 id —— 否则 agent 可以绕过带 scope 的检索路,直接按 id 从 PG 拉任意条款
   (dfzq-pi 规格 §2.5 的 widening 禁令)。
2. **观测**(`mark_fetched` / `unfetched` / `stats`):T7 的取证完整性判定要知道
   「检索到的 id 里有多少真的取过正文」。**`mark_fetched` 绝不放宽白名单** ——
   它只在既有的检索集合上打标,拿它当授权入口会让第 1 条失效。

**按 run_id 分桶,不靠进程隔离。** 今天一 run 一 MCP 进程,进程内的全局集合看似够用;
但 S3 会按 specId 池化 MCP 进程(dfzq-pi 规格 §3.3),到那时一个进程服务多个并发 run,
全局集合会让它们互取对方的条款详情 —— 那是权限越界,而且不会有任何报错。
"""

from __future__ import annotations

from collections.abc import Iterable


class _RunState:
    """一个 run 的状态。

    `retrieved` 用 dict 而非 set:`unfetched()` 要按**检索顺序**回,因为 C3 的 followUp
    会照这个顺序提示模型该补哪几条 —— 乱序会让提示读起来像随机抽的。
    (Python 3.7+ 的 dict 保插入序,这是语言保证不是实现细节。)
    """

    __slots__ = ("retrieved", "fetched")

    def __init__(self) -> None:
        self.retrieved: dict[str, None] = {}
        self.fetched: set[str] = set()


class RunRegistry:
    """`run_id → 该 run 的检索/取证记录`。

    生命周期跟随 MCP server 进程。一 run 一进程时进程退出即回收;池化后由调用方在 run
    结束时调 `forget()`。**没有 TTL 淘汰** —— 池化落地时要一并设计,否则长命进程会无界增长。
    """

    def __init__(self) -> None:
        self._by_run: dict[str, _RunState] = {}

    def _state(self, run_id: str) -> _RunState:
        return self._by_run.setdefault(run_id, _RunState())

    def record(self, run_id: str, clause_ids: Iterable[str]) -> None:
        """登记本次检索真正返回给模型的 id。

        累加而非覆盖:一个 run 会检索多次,后一次冲掉前一次会让模型引用早先命中的 id 时被拒。
        """
        state = self._state(run_id)
        for clause_id in clause_ids:
            state.retrieved.setdefault(clause_id, None)

    def allowed(self, run_id: str) -> set[str]:
        """本 run 可取详情的 id(**权限**)。

        未知 run 返回空集(fail-closed),不是「随便取」。
        返回**副本** —— 调用方改它不得改到内部状态,那会让白名单被静默放宽。
        """
        state = self._by_run.get(run_id)
        return set(state.retrieved) if state else set()

    def mark_fetched(self, run_id: str, clause_ids: Iterable[str]) -> None:
        """标记这些 id 已被取过正文(**观测**)。

        ⚠ **不放宽白名单**:只在既有 `retrieved` 上打标,没检索过的 id 打了也不算数。
        否则「先 mark 再取」就成了绕过 T4 约束的入口。
        """
        state = self._state(run_id)
        for clause_id in clause_ids:
            if clause_id in state.retrieved:
                state.fetched.add(clause_id)

    def unfetched(self, run_id: str) -> list[str]:
        """检索到但还没取过正文的 id,**按检索顺序**。C3 的判定依据。"""
        state = self._by_run.get(run_id)
        if not state:
            return []
        return [cid for cid in state.retrieved if cid not in state.fetched]

    def stats(self, run_id: str) -> dict[str, int]:
        state = self._by_run.get(run_id)
        if not state:
            return {"retrieved_count": 0, "fetched_count": 0}
        return {"retrieved_count": len(state.retrieved), "fetched_count": len(state.fetched)}

    def forget(self, run_id: str) -> None:
        self._by_run.pop(run_id, None)
