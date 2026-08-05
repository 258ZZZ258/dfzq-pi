---
name: audit-report
description: 生成常规、离任或反洗钱审计报告草稿；先核验数据完整性，再冻结事实包，最后按模板形成可追溯草稿并提交人工复核。
---

# 审计报告生成

本 Skill 只生成“待人工复核”的审计报告草稿，不发布、不盖章、不归档，也不替代审计人员作出最终专业判断。

## 强制流程

1. 调用 `get_report_task`，确认报告类型、机构、审计期间、离任对象和模板。
2. 调用 `get_organization_snapshot`、`get_personnel_snapshot` 和适用的业务工具取数。
3. 对审计发现先调用 `list_audit_findings` 获取完整 ID 集，再逐项调用 `get_audit_finding_detail`，不得依赖列表截断文字。
4. 调用 `list_rectification_records`，不得因为问题已整改而从报告中删除应披露问题。
5. 调用 `list_risk_events`。`MISSING` 与 `VERIFIED_NONE` 含义不同；缺失时必须阻断“未发生”结论。
6. 离任报告调用 `list_appointment_records`；反洗钱报告调用 `get_aml_facts`。
7. 调用 `prepare_report_fact_pack`。若 `blocked=true`，只能生成 `needs-input` 草稿，并明确列出缺失项。
8. 调用 `generate_report_draft` 得到证据绑定的结构化底稿。
9. 按 [报告规则](references/report-rules.md) 检查结构、固定文案、中文标点和表达，按 [数据源契约](references/data-source-contract.md) 检查来源。
10. 离任报告若 `turnover-historical-findings` 明确出现“规则比对未形成确定结论”，必须比较上次与本次问题的分类、问题细分、制度依据和事实描述，用语义判断确认是否属于同一个具体问题。报告中只保留“上次问题完整清单＋确认未整改的问题”；判定为不同具体问题时，不在报告中展开比较过程。该段最多两句，不得出现 finding ID、“规则比对”“语义一致性判断”“标题一致”“分类相同”“细分领域”等内部处理说明。
11. 最后调用 `submit_report_draft` 提交人工复核，不得自行归档。默认使用 `mode=baseline` 直接提交规则生成的完整底稿。经营情况分析段确需归纳，或上一步存在历史问题语义比对歧义时，才使用 `mode=paragraph-patch` 修改 `regular-operating-analysis`、`turnover-operating-analysis` 或 `turnover-historical-findings`；标题、引言、章节、问题事实、制度依据、结论、建议、落款和日期均为模板锁定内容。

## 不得执行

- 不得读取 Skill 目录以外的文件。
- 不得访问开放网络。
- 不得修改源系统数据。
- 不得补写不存在的文号、金额、排名、人数、问题数量或风险结论。
- 不得把 `MISSING`、`NOT_APPLICABLE` 或 `CONFLICTED` 改写成“无”“未发生”或“均符合要求”。
- 不得在没有 evidence ID 的情况下新增事实性句子。
- 不得提交整份自拟报告 JSON，也不得修改模板锁定段落。
- 不得输出模拟地址、零面积、零人数等占位值；遇到此类值必须将报告标记为 `needs-input`。
- 不得在中文正文中使用半角逗号、冒号、分号、问号、感叹号或括号。

## 输出要求

- 标题、章节、问题分组和表格必须适配报告类型。
- 金额保留原单位，不自动进行万元/元转换。
- 排名表仅输出取得有效排名的指标，必须同时保留分子和分母，定性采用五档规则。
- 每个问题保持 `finding_id`、完整问题详情、制度依据和整改状态。
- 人工判断内容必须保留 `human-review` 标记和修改留痕。
- Word标题、正文、章节标题、小标题、问题标题、表题、说明、落款和日期的字体、字号、缩进、行距、对齐及表格边框均从对应原始模板继承。
