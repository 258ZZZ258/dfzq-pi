"""达梦源库 → 预切块批次目录导出入口(``python -m pipeline.preseg_export <out_dir>``)。

甲方内网法规制度平台(达梦 DM8)→ 批次目录(SPEC-PRESEG §3 接收契约),之后由
``python -m pipeline.preseg_ingest <out_dir>`` 灌库。两步分离:导出可离线核对产物,灌库需 PG/模型栈。

**连接**:达梦 DSN **仅**走环境变量 ``PRESEG_SOURCE_DSN``(如 ``dm+dmPython://user:pwd@host:5236``;
驱动 ``dmPython`` + SQLAlchemy ``dm`` 方言,信创内网离线装)。不提供 ``--dsn`` CLI 入参——命令行参数
会落进 shell history / 进程列表 / 作业日志,泄露生产凭证(Codex)。

**一致性快照**:整批导出在**单连接单事务**内读全部 8 表(Codex:每查询新开连接会让主表/子表来自不同
时点,生成内部不一致却哈希自洽的"权威快照")。理想隔离级 REPEATABLE READ,按驱动能力尽力设置。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from pipeline.preseg.export import Source, build_batch

# ── 达梦 8 表读取(部署期真库联调;列集/列宽对齐 东方/东方知识库/图片 真 schema)──────
# DEL_FLAG 可空:SQL 用 (IS NULL OR <> 'D'),否则 NULL <> 'D' = UNKNOWN 会在库端静默漏行(Codex)。
_ALIVE = "(DEL_FLAG IS NULL OR DEL_FLAG <> 'D')"

_LAW_COLS = (
    "ID, CODE, NEW_CODE, NAME, DOC_NO, SCOPE, ISSUE_AUTH_CN, SUIT_OBJ_CODE, ISSUE_DATE, "
    "EFFECT_DATE, INVALID_DATE, STATUS_CODE, SOURCE_LAW_ID, LEVELS, TAG, CREATOR_ID, DEL_FLAG"
)
_CONTENT_COLS = "CODE, LAW_CODE, PATH_CODE, IS_CATALOG, TITLE, INDEX_NO, CONTENT, DEL_FLAG"
_CONTENT_DETAIL_COLS = (
    "ID, LAW_CODE, LAW_CONTENT_CODE, CONTENT_ORDER, CONTENT_TYPE, CONTENT, DEL_FLAG"
)
_CASE_COLS = (
    "CODE, NAME, DOC_NO, PUB_AUTH_CN, PUB_DATE, DOC_TYPE, EVENT_DATE, "
    "CASE_DESC, SUMMARY, URL, TAG, DEL_FLAG"
)
_PARTY_COLS = (
    "PARTY_INDEX, CASE_CODE, NAME, TYPE_CN, IDENTITY_CN, VIOL_TYPE_CN, FINE_AMT, "
    "CONFISCATE_AMT, CRIM_FINE_AMT, PUNISH_CUR_CN, AFFILIATION, SEC_CODE, SEC_SNAME, "
    "IND_CN, DISTRICT_CN, SECTOR_CN, HANDLER, STATUS, DEL_FLAG"
)
_PUNISH_COLS = (
    "CASE_CODE, LAW_CODE, LAW_CONTENT_CODE, PUNISH_INDEX, PUNISH_LAW, "
    "PUNISH_LAW_TITLE, CONTENT, DEL_FLAG"
)


class DmSource(Source):
    """达梦源实现:在**单连接**上只读查 8 表(一致性快照),行 → dict(大写列名键)。
    表间为应用层 CODE 关联(源库无物理外键),子表按父级 CODE 显式过滤。"""

    def __init__(self, conn) -> None:
        self._conn = conn

    def _rows(self, sql: str, **params: object) -> list[dict]:
        """查询 → 行 dict,**键统一大写**。

        转换层(``preseg/export.py``)按大写列名取值(``law.get("CODE")``)。达梦返回的键本就
        大写,``upper()`` 对它幂等;但这层归一是必需的——键的大小写由驱动/方言决定,不是契约。
        PostgreSQL 会把未加引号的标识符 fold 成小写,若不归一,所有 ``get("CODE")`` 静默返回
        None,导出出一批字段全空却结构合法的批次(比报错更坏)。仿真源库(tools/mock_source)
        正是走 PG 方言联调的。
        """
        from sqlalchemy import text

        return [
            {str(k).upper(): v for k, v in r._mapping.items()}
            for r in self._conn.execute(text(sql), params)
        ]

    def iter_laws(self) -> list[dict]:
        return self._rows(f"SELECT {_LAW_COLS} FROM ZNFG_IAM_LAW_BASIC WHERE {_ALIVE}")

    def contents_for(self, law_code: str) -> list[dict]:
        # ORDER BY 让每节点 2 物理行的去重"保留首见"确定(同 CODE 取最小 ID;Codex 二轮 F8)
        return self._rows(
            f"SELECT {_CONTENT_COLS} FROM ZNFG_IAM_LAW_CONTENT WHERE LAW_CODE = :c AND {_ALIVE} "
            "ORDER BY INDEX_NO, CODE, ID",
            c=law_code,
        )

    def content_details_for(self, law_code: str) -> list[dict]:
        """读取条款详情文本段。

        真实库有效 ``LAW_CONTENT`` 的正文几乎均为空；由转换层按
        ``LAW_CONTENT_CODE`` + ``CONTENT_ORDER`` 将这里的 ``CONTENT_TYPE=0`` 文本回填。
        图片、视频保留在源端但不进入当前纯文本检索契约。
        """
        return self._rows(
            f"SELECT {_CONTENT_DETAIL_COLS} FROM ZNFG_IAM_LAW_CONTENT_DETAIL "
            f"WHERE LAW_CODE = :c AND {_ALIVE} "
            "ORDER BY LAW_CONTENT_CODE, CONTENT_ORDER, ID",
            c=law_code,
        )

    def iter_cases(self) -> list[dict]:
        return self._rows(f"SELECT {_CASE_COLS} FROM ZNFG_IAM_LAW_CASE_BASIC WHERE {_ALIVE}")

    def parties_for(self, case_code: str) -> list[dict]:
        return self._rows(
            f"SELECT {_PARTY_COLS} FROM ZNFG_IAM_LAW_CASE_PARTY WHERE CASE_CODE = :c AND {_ALIVE}",
            c=case_code,
        )

    def punishes_for(self, case_code: str) -> list[dict]:
        return self._rows(
            f"SELECT {_PUNISH_COLS} FROM ZNFG_IAM_LAW_CASE_PUNISH "
            f"WHERE CASE_CODE = :c AND {_ALIVE}",
            c=case_code,
        )


def run(out_dir: Path) -> int:
    dsn = os.environ.get("PRESEG_SOURCE_DSN")
    if not dsn:
        print("✗ 未设置 env PRESEG_SOURCE_DSN(达梦 DSN);出于凭证安全不支持命令行传入")
        return 2
    from sqlalchemy import create_engine

    engine = create_engine(dsn)
    # 单连接单事务 = 一致性快照。**必须 REPEATABLE READ**:设置失败即中止(不 fail-open 到弱隔离
    # 出内部不一致却哈希自洽的"权威快照";Codex 二轮 F6)。驱动不支持 → 报错让运维改配置/换驱动。
    conn = engine.connect().execution_options(isolation_level="REPEATABLE READ")
    try:
        with conn.begin():
            stats = build_batch(DmSource(conn), out_dir)
    finally:
        conn.close()
    print(f"✓ 导出批次 → {stats['out_dir']}:laws={stats['laws']} cases={stats['cases']}")
    for w in stats.get("warnings", []):
        print(f"  ⚠ {w}")
    for s in stats.get("skipped", []):
        print(f"  ⨯ 拒收/跳过:{s}")
    print(f"  下一步:python -m pipeline.preseg_ingest {stats['out_dir']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipeline.preseg_export",
        description="达梦源库 8 表 → 预切块批次目录(DSN 走 env PRESEG_SOURCE_DSN)。",
    )
    ap.add_argument(
        "out_dir", type=Path, help="批次输出目录(生成 manifest.xlsx + blocks/ + cases.jsonl)"
    )
    args = ap.parse_args(argv)
    return run(args.out_dir)


if __name__ == "__main__":
    sys.exit(main())
