"""manifest 列契约(§3.1)—— 导入清单必填列,导入时校验,不匹配整批拒收。

**契约**:列名/顺序对齐生产 §3.1。V1.6 增 ``sub_type``(子类型:法律/规章/自律规则…,
驱动 issuer_level 分层与灰度)+ ``effective_date``(生效日期,upcoming 判定与时间窗过滤)。
"""

from __future__ import annotations

REQUIRED_COLUMNS = [
    "filename", "title", "doc_number", "issuer", "perm_tag",
    "corpus_type", "sub_type", "biz_domain", "issue_date", "effective_date", "supersedes",
]

# 版本业务字段来自内网制度主数据；它们是可选扩展，老批次继续可导入。
# 注意：这不是把技术 doc_version_id 暴露给上游，而是由源系统提供的业务版号/名称/修订序号。
OPTIONAL_VERSION_COLUMNS = ["version_code", "version_display_name", "revision_no"]
