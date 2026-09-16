# 审计报告与监督共享公共业务数据契约

## 1. 标识边界

- `task_id`：稳定业务任务标识。任务设置、成员、资料快照、问题、报告和审核均关联该标识。
- `run_id`：一次 Pi 模型执行或重试标识，记录在 `runs/run_events`；一个 `task_id` 可以对应多个 `run_id`。
- `report_version_id`：一次可审核、可定稿的报告版本；一个任务可以生成多个报告版本。

`run_id` 不得代替 `task_id`，模型执行记录也不得承担业务任务状态、资料范围或报告版本的持久化职责。

## 2. 公共任务记录

`BusinessTaskRecord` 对应建议公共表 `business_task`，从审计项目结构复用以下字段：

| 字段 | 含义 |
|---|---|
| `taskId` | 业务任务主键 |
| `taskCode` / `taskName` | 任务编号和名称 |
| `taskType` | `AUDIT_REPORT` 或 `SUPERVISION_ANALYSIS` |
| `taskSubtype` | 常规、离任、反洗钱或监督共享等子类型 |
| `organizationId` | 唯一被分析营业部编码 |
| `periodStart` / `periodEnd` | 审计或分析期间 |
| `taskStatus` | 草稿、运行、审核、完成等公共状态 |
| `versionNo` | 并发更新版本 |
| 创建更新字段 | 创建人、更新人和时间 |

审计报告继续在扩展结构中维护项目、模板、审计组成立月份、报告日期和审计对象；监督共享在
`SupervisionTaskConfigRecord` 中维护选填分析说明 `analysisDescription`、提取规则版本和持续整改统计口径。
监督任务不设置来源类型/部门范围、报告口径或独立整改截止日；公共任务期间同时约束问题、整改和问责。
创建或更新监督任务时，分析说明需与公共任务一起保存到监督扩展配置，并由 `toSupervisionTaskDescriptor` 还原。

## 3. 资料快照记录

`TaskMaterialSnapshotRecord` 与 `TaskMaterialSnapshotItemRecord` 对应建议公共表
`task_material_snapshot`、`task_material_snapshot_item`。快照明细同时保存：

- 文件和文件版本；
- OCR/解析版本和索引版本；
- 来源类型和上传入口；
- 单位编码和文件日期；
- 纳入或排除状态及排除原因。

任务开始后快照状态固定为 `FROZEN`。后续重新上传、重新 OCR 或重新索引不得改变历史快照，只能创建新快照或新任务运行。
监督任务的快照由后端自动筛选并固化，不等待用户选择或确认；`FROZEN` 表示本次使用版本已固定，不代表用户审批。

## 4. 问题与证据

`BusinessIssueRecord` 承载任务、单位、问题标题、事实、分类、重要程度、确认状态、源文档版本和证据标识。
审计报告可从 `audit_finding` 映射；监督共享将报告模块、提取规则和原始字段保留在监督扩展结构。

`EvidenceReferenceRecord` 统一保存页码、段落、表格行、`chunk_id` 或 `clause_id` 定位，并可携带制度查询/比对的
`source_code` 和 `source_doc_id`。业务问题只保存证据标识，不复制制度库正文或检索块正文。

## 5. 代码适配入口

- 审计报告：`toAuditBusinessTaskRecord`、`toAuditReportTask`。
- 监督共享：`toSupervisionBusinessTaskRecord`、`toSupervisionTaskDescriptor`。
- 监督资料快照：`toTaskMaterialSnapshotRecords`。
- 监督问题：`toBusinessIssueRecord`。

这些适配器只定义 Pi 与 Java/数据库之间的稳定字段边界，不实现 Java 表、上传接口、权限或数据库迁移。
