# Java 上传资料与监督分析接口

## 职责与存储

Java 文件中心、监督共享上传入口保存附件及资料元数据，自动记录上传人、上传部门、上传时间，处理共享和下载权限。
业务元数据包括标题、发文日期、资料类别、内外部文档、涉及单位；单位类型从组织目录取得。
复用文档/版本、文件存储、组织关联、权限及操作日志能力。无需甲方原始记录关联、甲方接口或新增导入记录表。

一个 `documentId` 标识本平台的一个附件文档，`documentVersionId` 标识其不可变版本；多附件分别对应文档标识。
Java 保存业务资料与附件的关联。文件名不充当唯一标识，更新正文后使用新版本并重新解析。
同一附件涉及多个单位时使用组织关联，不能复制正文并重复统计。权限变化由 Java 实时处理，不以旧快照授予预览权限。

Java 调用 audit-ai 复用现有解析/表格切分/索引链，按文档版本关联处理结果，检查回调版本后更新处理状态。
上传字段是基础元数据来源；正文中的发现日期、整改进展日期、问责决定日期和报告月份另行提取，不能覆盖发文日期。
问题、整改、问责和证据由解析/提取服务形成，不能把上传成功当作完成这些提取。
本契约不是新 OCR HTTP 端点，也不改变现有 audit-ai manifest、S4 审核或语料分区规则。

## Java 向 Pi 提交的资料投影

Schema：`specs/supervision-analysis/upload-material.schema.json`。
运行 payload 在现有 `task`、`snapshotAt`、`issues`、`rectifications`、`accountabilities` 之外使用
`uploadedMaterials` 和 `categoryMappings`，不同时传 `materials`。已有分析资料调用方继续使用原 `materials` 路径。

| 字段 | 约束 |
|---|---|
| `documentId`、`documentVersionId` | 本平台附件及版本标识，必填 |
| `fileName` | 必填；标题空白时作为引用名称 |
| `title` | 资料标题，优先用于引用展示 |
| `issueDate` | 发文日期，映射为 `fileDate`；缺失/无效日期留给自动筛选排除，不用上传日期补齐 |
| `categoryCode` | 本平台资料类别字典编码，必填；示例编码不是正式字典 |
| `documentOrigin` | `internal` / `external`，独立于上传部门和 audit-ai 语料分区 |
| `organizationIds` | 涉及单位 ID 数组；不能传名称或单位类型代替 ID。空数组自动排除 |
| `uploadDepartmentId`、`uploadedAt` | 可选操作元数据，不参与筛选或分类，不进入模型事实输入 |
| `uploadEntry` | `file-center` / `supervision` |
| `processingStatus` | `indexed` / `processing` / `failed` / `needs-metadata` / `disabled` |
| `parseVersion`、`indexVersion` | `indexed` 必填，绑定实际处理结果，不得以占位版本冒充入库 |

对未知字段和错误类型拒绝输入。结构完整但日期无效、日期缺失、无涉及单位或尚未入库的资料，按现有快照逻辑记录排除原因；其余资料继续。
单位 ID 去空白和去重；不会依据简称猜测组织身份。上传文档的 `dataOrigin` 转为 `internal`，这里表示平台业务资料来源，
不等于其 `documentOrigin` 必须为内部文档。

Java 先按当前用户/任务权限取出允许分析的资料，再构造此投影。角色、人员共享名单和禁止下载标识留在 Java，
不作为 Pi 的权限判断依据。禁止下载与允许分析分别由 Java 的既有权限规则处理，不推导授权。

## 类别配置与运行示例

`categoryMappings` 由后端配置并组装，不能由前端任务表单或模型随意指定。每条映射含 `categoryCode`、
`sourceType` 和可选 `documentOrigin`。配置只按类别及可选内外部属性匹配；上传部门不作为分类条件。
每个输入资料必须恰好命中一条；未知或重叠映射是接口配置错误，拒绝该次输入并返回错误，不猜测分类。
宽泛类别应在上传字典/后端分类配置中细化，不能假设图片显示的类别已覆盖全部九个报告模块。

以下为可执行的最小输入，空事实数组仅演示资料适配，不代表已提取问题：

```json
{
  "task": { "taskId": "TASK-1", "organizationId": "ORG-1", "analysisStart": "2026-01-01", "analysisEnd": "2026-06-30" },
  "snapshotAt": "2026-09-04T10:00:00+08:00",
  "uploadedMaterials": [{
    "documentId": "DOC-1", "documentVersionId": "DOC-1-V1",
    "fileName": "监管函.pdf", "title": "监管检查函", "issueDate": "2026-06-30",
    "categoryCode": "TEST_REG", "documentOrigin": "external", "organizationIds": ["ORG-1"],
    "uploadEntry": "supervision", "processingStatus": "indexed",
    "parseVersion": "parse-1", "indexVersion": "index-1"
  }],
  "categoryMappings": [{ "categoryCode": "TEST_REG", "sourceType": "regulatory" }],
  "issues": [], "rectifications": [], "accountabilities": []
}
```

`parseSupervisionAnalysisPayload` 已接入上传适配器，转换后进入既有工具集和快照。转换输出仍为
`supervision-analysis.v1`，报告引用仍使用 `title`、`documentId`、`documentVersionId`，不扩充右侧展示复杂度。
任务资料范围自动处理，无资料选择或确认步骤。

## 验证与未接入部分

```sh
node ../../node_modules/vitest/dist/cli.js --run test/supervision-upload-material.test.ts test/supervision-analysis.test.ts
```

当前完成 Pi 契约、校验和运行适配；Java 上传接口、元数据落库、权限筛选及 audit-ai 业务提取结果的生产组装仍需联调。
类别字典尚需由实际上传系统配置，不在代码中猜测客户编码。本轮不调整 RAG 参数，不增加数据库迁移或新的上传链路。
