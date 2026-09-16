"""达梦库标识生成(CP-013)。**确定性 = 幂等之根**,与 ``chunk_id`` 公式同级对待。

源库无主键无外键,重跑靠"同输入 → 同 CODE"再按 CODE 覆盖旧行来保证幂等。因此这里的函数
**必须是纯函数且跨进程稳定**——不可掺时间戳、随机数、内存地址。

形态与甲方同构(联调 fake 库,不混库,故前缀直接沿用 ``ELA7``;真要区分来源时改这一处即可):

- ``LAW_BASIC.CODE``      ``ELA7`` + 32 位大写 hex = 36 字符
- ``LAW_CONTENT.CODE``    law_code + 序号,序号 **≥3 位、不足补零**(甲方观察值恒 3 位)
- ``ID``                  19 位数字(Snowflake 形态,但由内容 hash 派生以保确定性)
"""

from __future__ import annotations

import hashlib

#: 甲方 CODE 前缀。fake 库不混库 → 沿用同一前缀最省事(用户 2026-07-27 决策)。
CODE_PREFIX = "ELA7"

#: LAW_CONTENT 序号最小宽度。甲方真数据恒 3 位(单部法规 ≤999 节点);
#: 超出自然进位到 4 位——《民法典》1260 条会走到这条路径,CODE 列宽 256 撑得住。
_SEQ_MIN_WIDTH = 3


def _hex32(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32].upper()


def law_code(logical_key: str) -> str:
    """文档逻辑键 → ``LAW_BASIC.CODE``(36 字符,确定性)。

    ``logical_key`` 取文档的稳定身份(默认 manifest 的 ``filename``)——**同一文档重跑必须
    得到同一 CODE**,否则重跑会在库里堆出重复法规而不是覆盖。
    """
    return CODE_PREFIX + _hex32(logical_key)


def content_code(law: str, seq: int) -> str:
    """(law_code, 节点序号) → ``LAW_CONTENT.CODE``。序号 ≥3 位补零,超 999 自然变宽。"""
    return f"{law}{seq:0{_SEQ_MIN_WIDTH}d}"


def snowflake_id(key: str) -> str:
    """内容键 → 19 位数字 ID(Snowflake 形态)。

    真 Snowflake 含时间戳与机器位,这里**故意不那样做**:ID 必须随内容确定,重跑才幂等。
    取 hash 前 15 位 hex 映射进 19 位十进制区间(下界非零,保证位数恒定)。
    """
    n = int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:15], 16)
    lo, hi = 10**18, 10**19 - 1
    return str(lo + n % (hi - lo))
