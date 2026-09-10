# 监督报告逐段来源

在原有正文 JSON 中增加 paragraphSources 对象。正文仍是字符串，保留原有全部字段和主题数组。

paragraphSources 必须为以下每个正文块提供且仅提供一个条目：
executiveSummary、regulatoryOverview、regulatoryRectification、externalAuditAnalysis、
internalInspectionOverview、accountabilityAnalysis、violationAccountabilityAnalysis、
routineComplianceAnalysis、routineRiskAnalysis、litigationAnalysis；
每个监管主题另有 regulatoryIssues.0.analysis、regulatoryIssues.1.analysis 等条目；
每个内部检查主题另有 internalInspectionThemes.0.analysis 等条目。数组下标从 0 开始。

每个条目严格包含四个字符串数组：
{"documentVersionIds":[],"issueIds":[],"rectificationRecordIds":[],"accountabilityRecordIds":[]}

- 只列出该段实际采用的来源。概括或统计段也须明确列出实际支撑该段的资料或记录。
- 引用问题使用 issueIds，引用整改措施/状态使用 rectificationRecordIds，引用问责使用 accountabilityRecordIds。
- 不涉及具体问题的文件内容可通过 documentVersionIds 引用。只能选择 documents 中给出的版本编号。
- 同一问题所属的资料无需重复列进 documentVersionIds，程序会从问题/记录推导文件，去重后提供资料名称。
- 主题正文的 issueIds 必须包含主题对象的全部 issueIds。问题必须已确认；整改/问责记录必须已有确认关联。
- 不能用一个问题的原始监管函代替其整改情况表来支撑“已完成整改”。不能将全部资料复制到每一段。
- 没有来源时四个数组留空。缺资料不能据此断言“未发生”“已完成”或“无问题”，程序会要求复核。
- 不输出资料标题、URL、相似度、页码或本地文件路径；资料标题与类型由程序从固化快照读取。
