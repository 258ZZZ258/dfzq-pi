"""P-PRESEG:预切块数据源适配域(CP-010)。

源系统(法规制度平台)已按条切块的语料 + 现成案例链接的接入:
reader(接收契约)/ derive(条款标识→norm 推导)/ adapter(块流→ChunkSpec)/
status_map(效力状态映射)/ cases_ingest(案例结构化直装)。
设计:docs/preseg-docs/SPEC-PRESEG.md;决策 D1–D8 见调研报告 v0.2 §6。
"""
