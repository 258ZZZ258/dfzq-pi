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

## XLSX 依赖说明

生产经营数据源当前是既有 XLSX 工作簿，因此通过隔离在 `report-data-source.ts` 的
`@e965/xlsx` 适配层读取。该包是 SheetJS 社区版的维护性发布，供应链风险通过精确锁版、禁止
安装脚本和单一适配边界控制。后续可在输入格式允许时替换为 ExcelJS，或改用经内部制品库审核的
SheetJS 官方构建；业务模型与报告规则不依赖该实现。
