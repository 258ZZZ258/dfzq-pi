"""文档解析产物 → 达梦知识库 8 表(CP-013 dm_sink)。

**方向**:PDF/docx → 解析 → 条款树 → ``ZNFG_IAM_LAW_BASIC`` + ``ZNFG_IAM_LAW_CONTENT``。
与 ``preseg`` 相反(后者是达梦 → 批次目录 → PG)。两者合起来闭环:

    PDF ─→ dm_sink ─→ 达梦库(统一底座)─→ preseg_export ─→ preseg_ingest ─→ PG + Milvus

**分层职责**(用户定的口径,2026-07-27):达梦库只承载**源级信息**(法规主表 + 条款树);
我方一切加工物(密级/业务域/E1·E2 富集/向量冷备/QC 留痕)都归"达梦→PG"那一步产生,
不写进达梦。**页码全链不要**(与 CP-010 决策 D2 零页码设计一致)。
"""

from pipeline.dm_sink.codes import content_code, law_code, snowflake_id
from pipeline.dm_sink.mapper import DmRows, map_document

__all__ = ["DmRows", "content_code", "law_code", "map_document", "snowflake_id"]
