# 监督报告逐段引用文档包

`supervision-analysis.v1` 仍为分析结果。正文生成步骤现在同步输出
`supervision-report-document.v1`，用于在线编辑页的段落和引用资料列表。
此文档包不代表 Java 保存/编辑接口或前端页面已经实现。

## 生成与离线导出

在 task-runtime 包目录执行：

```sh
npm run generate:supervision-narrative -- \
  --analysis /var/lib/task-runtime/analysis.json \
  --records /var/lib/task-runtime/records.json \
  --output /var/lib/task-runtime/narrative.json \
  --document-output /var/lib/task-runtime/document.json
```

省略 `--document-output` 时输出到 `<正文输出路径>.document.json`。
只有正文与全部来源映射校验通过才写出结果；模型只从进程读取密钥。
正文沿用 `supervision-report-narrative.v2` 字段并增加 `paragraphSources`，现有 Word 渲染器可直接读取。

已经包含逐段来源的正文可离线导出，不调用模型：

```sh
npm run export:supervision-document -- \
  --analysis /var/lib/task-runtime/analysis.json \
  --narrative /var/lib/task-runtime/narrative.json \
  --records /var/lib/task-runtime/records.json \
  --output /var/lib/task-runtime/document.json
```

离线导出拒绝覆盖已有文件。旧正文缺少 `paragraphSources` 时明确失败；需要重新生成带来源的正文，
或由业务核对补齐映射后导出。不得按章节给旧段落自动绑定全部资料。

`records` 包含整改及问责数组，来源编号必须与分析快照一致。OCR 样本运行脚本会同步输出
`<分析输出路径>.records.json`，可用 `SUPERVISION_RECORDS_OUTPUT_PATH` 指定路径；
不要将 OCR 编号与原始 fixture 编号混用。生产环境由资料服务提供同一任务快照下的记录。

## 页面使用

1. 左侧按 `nodes` 的 `parentId` 和 `order` 展示目录，正文编辑框使用 `nodeType=paragraph` 且 `textEditable=true` 的节点。
2. 选中段落后，以 `citationIds` 查找顶层 `citations`，默认只展示 `title`，可附加 `sourceType` 标签。
3. 点击资料名称时，将 `documentId` 和 `documentVersionId` 交给现有文件预览服务，由 Java 校验访问权限。
   文档包不提供本地路径、假定的预览 URL、匹配度或相似度。
4. 同一段落的同一文档版本仅列一次；同名的不同资料仍保留独立标识。
5. `citationStatus=NO_SOURCE` 时列表为空、`requiresHumanReview=true`。`LINKED` 仅代表来源标识和范围已校验，
   不代表机器已证明每句文字得到证据支持。标题、固定范围说明和任务元信息不伪造文件引用。

## 文档结构

完整结构见 `specs/supervision-analysis/report-document.schema.json`。

```json
{
  "nodeId": "regulatoryRectification",
  "nodeType": "paragraph",
  "parentId": "regulatory-rectification",
  "order": 12,
  "text": "相关问题已按整改计划落实……",
  "styleRef": "report.paragraph.body",
  "textEditable": true,
  "citationIds": ["document:RECT-V1"],
  "citationStatus": "LINKED",
  "requiresHumanReview": false
}
```

```json
{
  "citationId": "document:RECT-V1",
  "title": "整改情况表",
  "sourceType": "internal-audit",
  "documentId": "RECT",
  "documentVersionId": "RECT-V1"
}
```

`lineage` 按段落保留问题、整改、问责及证据编号，供后台追溯，无需默认展示在页面。
问题严格核对来源文档与版本、被分析单位及确认状态；整改和问责必须存在已确认关联。
整改/问责有 `sourceDocumentVersionId` 时精确匹配该版本；未提供时必须在快照中唯一对应一个版本，否则拒绝导出。
资料日期、问题发现日期和整改/问责业务日期均须在任务分析期间内；不接受独立整改截至日期或期间外引用。
任务配置见 `docs/supervision-analysis-contract.md`，选填分析说明只用于撰写背景，不作为引用资料。

正文中的每个固定字符串字段为一个编辑段落，每个主题的 `analysis` 为一个编辑段落，
与 Word 当前的正文块粒度一致。主题节点 ID 根据主题的问题编号集合生成，修改标题或调整主题顺序不改变其 ID；
拆分/合并主题会产生新的节点 ID，需作为新报告版本处理。

`structureHash` 标识节点结构；`contentHash` 同时覆盖任务、快照时间、正文、引用和追溯关系。
Java 以后实现逐段保存时，需要用保存版本号或 `contentHash` 做并发校验，不能只用结构哈希。
人工修改涉及事实或结论时应标记引用待核验；引用绑定不应由前端任意回传覆盖。
Pi 已提供内容版本校验的文字修改函数和引用复核函数，见 `docs/supervision-optimization.md`。这不等于 Java 修改接口已经实现；保存、权限、最终并发写入和用户编辑后的 Word 导出仍由业务服务接入。
