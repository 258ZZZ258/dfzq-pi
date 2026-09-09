# task-runtime → Java 审计报告契约

适用于 `POST /runs` / `GET /runs/:runId` 的 `taskKind: "audit-report"`。Java 必须先判断 run 状态：
`queued` / `running` 时继续轮询，只有 `completed` 时读取 `answer`；其他终态按生成失败处理。

## 1. 提交请求

```json
{
  "taskKind": "audit-report",
  "input": "生成常规审计报告",
  "clientRequestId": "TASK-001:1",
  "sessionId": "TASK-001",
  "options": {
    "reportTaskId": "TASK-001",
    "reportType": "regular"
  },
  "filters": {"owner":"current-user","projectId":"PROJECT-001","corpusTypes":["internal"]},
  "waitMs": 0
}
```

`reportType` 可取 `consultation`、`regular`、`turnover`；不再接收 `aml`。反洗钱是常规报告同文件附件，征求意见书与离任报告不附此附件。

上例不含 payload，限既有服务端配置的 HTTP/Excel 适配入口。生产快照入口必须额外传 `payload: {"schemaVersion":"audit-report-input.v2","dataset":...}`。dataset 为 `AuditReportDataset`，由 Java 组装、授权和冻结；前端不得自行传数据源 URL、文件路径、workflow 来源版本或证据编号。两种入口不能混为一谈。

dataset.task.workflow 包含 `mode`、布尔值 `matchingCompleted`、`consultationExists`。独立常规 mode=independent；关联常规 mode=linked，必须附 sourceReportId、sourceVersion、sourceDataVersion、completed 状态的 feedbackStatus/resolutionStatus、feedbackCompletedAt；征求意见 mode=consultation，需 feedbackDeadline（YYYY-MM-DD）及 feedbackRequirement；离任 mode=turnover。

检查项目放 dataset.checks，code 名称以 `report-workflow.ts` 为准：常规和征求意见需要常规12项及反洗钱8项输入，离任需要18项；异常或不适用需 factText，数量必须是非负整数，异常数不得超过检查数。征求意见虽不输出反洗钱附件，相关问题仍纳入本次问题及后续复用快照。

反馈后可以修改或删除问题，常规使用生效快照，不要求与原始征求意见书的问题集合机械一致。Pi 返回 report.workflow 保留来源版本。详细业务端接口及部署边界见 [报告流程联调](report-workflow-integration.md)。

## 2. `answer` 文档包

```jsonc
{
  "schemaVersion": "audit-report-document.v1",
  "structureHash": "sha256:...",
  "report": {
    "taskId": "TASK-001",
    "templateId": "regular-audit-report",
    "templateVersion": "3.2",
    "introduction": {
      "paragraphId": "regular-introduction",
      "text": "……",
      "evidenceIds": ["EV-DS-01-TASK-001-auditStart"],
      "requiresHumanReview": false
    },
    "sections": [],
    "status": "ready-for-review"
  },
  "nodes": [
    {
      "nodeId": "regular-introduction",
      "nodeType": "paragraph",
      "order": 3,
      "text": "……",
      "styleRef": "report.paragraph.body",
      "textEditable": true,
      "citationIds": ["EV-DS-01-TASK-001-auditStart"],
      "requiresHumanReview": false
    }
  ],
  "citations": [
    {
      "citationId": "EV-DS-01-TASK-001-auditStart",
      "title": "审计项目 · TASK-001",
      "summary": "2025-01-01",
      "sourceType": "business-record",
      "source": {
        "sourceId": "DS-01",
        "sourceName": "审计项目",
        "sourceRecordId": "TASK-001",
        "sourceField": "auditStart",
        "authority": "primary",
        "sourceCatalogRegistered": true
      },
      "lineage": {
        "mode": "direct-field",
        "evidenceIds": ["EV-DS-01-TASK-001-auditStart"]
      },
      "asOf": "2025-03-31",
      "dataVersion": "v1"
    }
  ]
}
```

完整字段以 `specs/audit-report/output-contract.schema.json` 为准。当前版本有以下约束：

- `report` 保留完整报告结构，继续供 Word 渲染、审计校验和存档使用。
- `nodes` 是按文档顺序展开的只读结构视图。段落节点的 `nodeId` 与 `report` 中的 `paragraphId` 完全一致；
  标题、表格、落款等结构节点的 `textEditable` 为 `false`。
- 段落的 `citationIds` 关联顶层 `citations[].citationId`。一个 citation 对应一个已校验 evidence，
  本版不包含 `matchScore`、相似度或模型估算分。
- `structureHash` 只覆盖模板版本、节点 ID、父子关系、顺序和样式引用。只改段落文字时哈希不变；
  Java 可用它做结构完整性或并发更新校验。
- citation 不返回本地文件绝对路径，也不返回内部匹配推理。
- 证据存在但数据源目录漏登时仍保留真实 `sourceId`，同时返回 `sourceCatalogRegistered=false`、
  `authority="unknown"` 和明确的“未登记数据源”名称，供 Java 提示补全目录；不会猜测来源名称或权威等级。

## 3. Java 侧逐段修改建议

### 逐段依据（Pi已实现）

每个正文段落及表格节点新增 `basis`。右侧仅展示“依据来源”，不提供匹配度、“质量提示”或“AI建议”。

| 字段 | 用途 |
|---|---|
| basis.kind | business-record：业务记录依据；template：明确登记的模板段落；missing：没有可用引用，不能冒充模板 |
| basis.template | 模板ID、版本、段落位置，仅模板段落返回 |
| basis.sourceGroups | 按来源ID＋记录ID＋时点＋版本分组，同一来源记录的不同字段合并展示 |
| sourceGroups[].citationIds | 该段落用到的字段引用；从顶层 citations 读取字段名、原值摘要，不展示其他段落的字段 |
| basis.textHash | 原始段落文字的UTF-8 SHA-256，供判断编辑后是否需要重新核验 |

“依据数量”使用当前段落的 sourceGroups.length，不是字段引用个数。模板段落展示模板信息；missing 展示缺少来源，不能显示为已核验。空表格可能没有业务来源，不应伪装为模板。

引用分组只表示生成时使用的来源，不代表模型置信度或已完成语义真实性核验。点击查看记录需要 Java 按 sourceId/sourceRecordId/dataVersion 解析为有权限的业务页面；Pi 不输出本地路径或任意跳转URL。

### 编辑及最终校验

`reportBasisNeedsRecheck(originalNode, editedText)` 可判断正文是否已改动。原文哈希不应被编辑动作直接重置；原依据继续保留作历史依据，适用性需重新核验。该函数不声称自动审查了修改后的语义，也不包含 Java 保存接口。

Pi 最终判官调用 `validate_report_document`，与当前任务最近生成或通过受限改写工具的文档逐字段比较，核验正文、节点、表格、引用、来源值、流程、结构哈希和依据分组的一致性。未生成基准、缺字段、额外字段、替换引用或模型自行改写均不通过。JSON键顺序不影响比较，数组顺序必须一致。失败经有限重试后返回 error，而非 completed。最终一致性不等于原始业务数据真实性审计。

Java 对外接收段落修改时，建议使用下列业务请求，不要让前端回传整份 `report`：

```json
{
  "taskId": "TASK-001",
  "structureHash": "sha256:...",
  "nodeId": "regular-introduction",
  "text": "用户修改后的段落正文"
}
```

Java 更新前应依次校验：`structureHash` 与当前版本一致、`nodeId` 存在、节点类型为 `paragraph`、
`textEditable=true`。随后只替换同 ID 段落的 `text`，不得接受标题、顺序、样式、引用 ID 或段落数量变更。
用户修改后的版本应另行保存，避免覆盖智能体原始生成稿和取证留痕。
