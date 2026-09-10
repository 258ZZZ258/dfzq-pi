# @dfzq/task-runtime

## 审计报告任务

审计报告使用统一 RuntimeSpec：`specs/audit-report.json`。模型由 ProviderProfile 的 `main`
角色决定，代码中不绑定厂商或模型 ID。

Server 请求在 `options` 中传：

```json
{
  "reportTaskId": "审计项目主键",
  "reportType": "regular"
}
```

服务环境同时配置 `AUDIT_REPORT_API_BASE_URL` 和 `AUDIT_REPORT_OPERATING_WORKBOOK`。前者指向
审计、人力、OA、机构、风险和反洗钱聚合接口；后者指向生产经营数据工作簿。源码和测试不提供
业务全量数据或 Office fixture。

CLI 等价入口：

```sh
task-runtime run \
  --spec ./specs/audit-report.json \
  --profile /secure/provider-profile.json \
  --workdir /var/lib/task-runtime/run-1 \
  --input '生成审计报告草稿' \
  --report-task-id AUDIT-TASK-001 \
  --report-type regular \
  --audit-api-base-url http://audit-source.internal \
  --operating-workbook /secure/operating-data.xlsx
```

测试：从仓库根目录运行 `./test.sh`，或在本包运行定向命令
`node ../../node_modules/vitest/dist/cli.js --run test/audit-report-agent.test.ts`。

DOCX 渲染先安装锁定依赖：

```sh
python -m pip install -r ./scripts/audit-report/requirements.txt
python ./scripts/audit-report/render_report_docx.py \
  --template /secure/template.docx \
  --draft /var/lib/task-runtime/report-draft.json \
  --output /var/lib/task-runtime/report.docx
```

渲染器要求外部模板提供对应段落和表格原型，字体、字号、缩进、间距、对齐和边框均从模板继承；
缺少原型会直接失败，不使用代码猜测格式。

## 监督共享信息报告

监督共享信息分析先生成 `supervision-analysis.v1` JSON，再由项目内 DOCX 渲染器输出正式中文报告。
渲染器同时接收任务快照中的整改、问责记录；OCR 批次结果为可选输入，用于生成资料处理情况章节。
每项任务只接受一个 `organizationId`。候选资料先按单位、分析期间和处理状态进行结构化筛选；
随后生成不可变的文档版本/索引版本范围，BGE-M3 及关键词检索只能在该快照范围内执行。
问题、整改和问责统一限定在分析期间内，不另设整改截至日期。固定生成监督信息汇总分析报告，
选填 `analysisDescription` 提供分析背景和特别关注事项；任务不设置来源类型/部门范围或报告口径。
创建任务与持久化映射见 [监督分析输入契约](docs/supervision-analysis-contract.md)。

```sh
python ./scripts/supervision-analysis/render_supervision_analysis_docx.py \
  --analysis /var/lib/task-runtime/supervision-analysis-result.json \
  --records /var/lib/task-runtime/supervision-records.json \
  --ocr /var/lib/task-runtime/supervision-ocr-result.json \
  --output /var/lib/task-runtime/supervision-analysis-report.docx
```

DOCX 使用 A4 正式报告版式，正文和表格不依赖前端或 Java 渲染。生产环境应由任务运行目录或服务接口
提供分析结果、整改问责记录和可选 OCR 结果，不应引用测试 fixture。

可选的 DeepSeek 正文归纳步骤只从当前进程读取 `DEEPSEEK_API_KEY`，不读取或加载 `.env`：

```sh
npm run generate:supervision-narrative -- \
  --analysis /var/lib/task-runtime/supervision-analysis-result.json \
  --records /var/lib/task-runtime/supervision-records.json \
  --output /var/lib/task-runtime/supervision-report-narrative.json
```

脚本只允许模型引用输入中存在的问题编号，并校验公开监管问题是否全部被主题分析覆盖；缺少密钥时直接失败。
生成时还会逐段校验 `paragraphSources` 并输出 `<正文输出路径>.document.json`。
文档包为 `supervision-report-document.v1`，包含可编辑段落及按资料版本去重的引用名称列表。
可用 `--document-output` 指定路径，也可用 `npm run export:supervision-document --` 离线导出。
接口字段、来源约束及完整命令见 [监督报告逐段引用契约](docs/java-supervision-report-contract.md)。

DeepSeek 正文通过校验后，可生成以段落分析为主、正文无大表的 Word 报告：

```sh
npm run render:supervision-narrative-report -- \
  --analysis /var/lib/task-runtime/supervision-analysis-result.json \
  --narrative /var/lib/task-runtime/supervision-report-narrative.json \
  --records /var/lib/task-runtime/supervision-records.json \
  --ocr /var/lib/task-runtime/supervision-ocr-result.json \
  --output /var/lib/task-runtime/supervision-analysis-report.docx
```

## XLSX 依赖说明

生产经营数据源当前是既有 XLSX 工作簿，因此通过隔离在 `report-data-source.ts` 的
`@e965/xlsx` 适配层读取。该包是 SheetJS 社区版的维护性发布，供应链风险通过精确锁版、禁止
安装脚本和单一适配边界控制。后续可在输入格式允许时替换为 ExcelJS，或改用经内部制品库审核的
SheetJS 官方构建；业务模型与报告规则不依赖该实现。
