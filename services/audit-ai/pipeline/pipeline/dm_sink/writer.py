"""达梦库写入(CP-013)。行集 → ``LAW_BASIC`` / ``LAW_CONTENT`` / ``LAW_CONTENT_DETAIL``。

**幂等靠"先按 CODE 删,再插"**:源库无主键无外键(甲方设计如此),没有 ON CONFLICT 可用。
删除范围严格限定在本文档的 CODE(law_code 及其 content / content_detail 行),不触碰他人数据
—— 尤其不能按 batch/时间范围删,那会误伤甲方 ETL 灌的行。

⚠ **详情表必须一起删**:正文在 ``LAW_CONTENT_DETAIL``,只删主表会把上一版的正文段留成孤儿。
它们的 ``LAW_CONTENT_CODE`` 由 ``content_code(code, seq)`` 派生 —— 重跑若节点数变少,旧的高位
序号段就再也不会被覆盖,却仍按 ``LAW_CODE`` 被 ``preseg.export`` 读到,拼出"新旧混合"的正文。

同一连接单事务:一份文档的三张表要么全进要么全不进,不留半截法规。
"""

from __future__ import annotations

from pipeline.dm_sink.mapper import DmRows


class DmWriter:
    """达梦(或其 PG 仿真)写入器。``conn`` = SQLAlchemy Connection。"""

    def __init__(self, conn) -> None:
        self._conn = conn

    def _exec(self, sql: str, params) -> None:
        from sqlalchemy import text

        self._conn.execute(text(sql), params)

    def delete_law(self, code: str) -> None:
        """按 law CODE 清掉旧行(幂等重跑的前半步)。详情表先删——它是正文所在。"""
        self._exec("DELETE FROM znfg_iam_law_content_detail WHERE law_code = :c", {"c": code})
        self._exec("DELETE FROM znfg_iam_law_content WHERE law_code = :c", {"c": code})
        self._exec("DELETE FROM znfg_iam_law_basic WHERE code = :c", {"c": code})

    def write(self, rows: DmRows) -> None:
        """写一份文档(调用方负责事务边界)。"""
        self.delete_law(rows.code)
        self._insert("znfg_iam_law_basic", [rows.law])
        self._insert("znfg_iam_law_content", rows.contents)
        self._insert("znfg_iam_law_content_detail", rows.content_details)

    def _insert(self, table: str, records: list[dict]) -> None:
        if not records:
            return
        cols = list(records[0])
        sql = (
            f"INSERT INTO {table} ({', '.join(cols)}) "  # noqa: S608 — 列名来自 mapper 字面量
            f"VALUES ({', '.join(':' + c for c in cols)})"
        )
        for i in range(0, len(records), 500):
            self._exec(sql, records[i:i + 500])
