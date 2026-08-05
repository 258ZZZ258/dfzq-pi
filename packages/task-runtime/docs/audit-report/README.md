# 审计报告生成智能体 MVP

本模块位于 `packages/task-runtime`，在东方证券 Pi Task Runtime 上提供审计报告生成能力，覆盖常规审计、离任审计和反洗钱审计。

## 已实现

- Pi 原生 `audit-report` Skill。
- 14 个白名单工具：任务、机构、人员、任免、经营指标、问题列表、问题详情、整改、风险事项、反洗钱事实、事实包、草稿和提交。
- 机构、项目、审计期间的请求级范围控制。
- `VERIFIED_VALUE / VERIFIED_NONE / USER_CONFIRMED / MISSING / NOT_APPLICABLE / CONFLICTED` 六态数据准备。
- 运行时数据接入：审计系统、OA、人事、审计发现/整改、风险、反洗钱和绩效通过 HTTP API 获取，经营指标从双层表头 Excel 解析。
- 模拟环境使用真实 localhost HTTP 服务和真实 `.xlsx` 文件；报告进程不再导入代码 fixture。
- 事实包冻结、五档排名、完整问题 ID 集和证据 ID 绑定。
- 常规、离任、反洗钱三类结构化草稿及 Markdown/Word 输出。
- 107 项基础 0/1 Rubric（新增正文相邻重复短语门禁），以及按报告内容动态生成的主张级 0/1 Rubric。
- 每个可变句拆分为事实主张；逐条核对 `sourceId + sourceRecordId + sourceField + rawValue`，未定位来源、值不一致或存在额外未支持事实均记 0。
- 风险数据缺失陷阱：缺失时阻断，不输出“未发生”结论。
- 提交阶段执行完整 Schema、必需章节、段落、表格、证据和人工复核标记校验。

## 运行

在仓库根目录执行：

```powershell
npm run demo:audit-reports -w @dfzq/task-runtime
npm run demo:audit-reports:live -w @dfzq/task-runtime -- regular
npm run evaluate:audit-reports:strict -w @dfzq/task-runtime
node node_modules\vitest\dist\cli.js --run packages\task-runtime\test\audit-report\audit-report-agent.test.ts
```

可直接运行的模拟数据源位于 `packages/task-runtime/fixtures/audit-report/source-simulation`：

- `模拟审计系统全量数据.xlsx`：模拟审计、人力、OA、经营、合规和反洗钱等系统数据；报告运行时通过 localhost HTTP 接口和 Excel 适配器读取；
- `报告任务输入.json`：只包含任务 ID、报告类型和用例 ID；
- `数据源配置.json`：声明 HTTP 系统源和 Excel 文件源。

三类正式 Word 模板位于 `packages/task-runtime/fixtures/audit-report/templates`，经最终核验的三份示例报告位于 `packages/task-runtime/examples/audit-report/generated-reports`。历史报告批量回放脚本保留在 `packages/task-runtime/scripts/audit-report`，原始人工报告因属于项目资料，不复制到代码仓库。

默认报告输出目录位于 `packages/task-runtime/output`，其中包含：

- `source-read-trace.json`：每次 HTTP/Excel 取数位置、条数、查询时间和数据版本；
- `system-http-trace.json`：模拟系统实际收到的 HTTP 请求；
- `normalized-source-snapshot.json`：各来源归一化后的冻结快照，不是输入 fixture；
- `fact-pack.json`：冻结事实包；
- `structured-draft.json`：结构化草稿；
- `report.md`：Markdown 报告；
- `rubric-score.json`：逐项 0/1 得分及理由；
- `strict-claim-score.json`：逐句、逐主张的字段级核验结果；
- `source-coverage.json`：设计覆盖和生产接入就绪度；
- `智能体生成-*.docx`：基于正式模板生成的 Word 草稿。

## Pi 实际接入

`report-data-source.ts` 先根据任务 ID 调用系统接口，并从经营 Excel 按机构代码解析指标；每个返回字段生成带来源地址、查询时间、数据版本和单元格/接口定位的 evidence。归一化快照冻结后，`createAuditReportSession` 创建只加载审计报告 Skill 和白名单工具的 Pi 会话，并调用 `/skill:audit-report`。内置 Shell、开放文件读取、开放网络和自由 SQL 均未开放。

`demo:reports` 是确定性接入基线；`demo:reports:live` 显式调用配置的模型，保存模型消息、真实工具轨迹、模型提交草稿和 Rubric 结果。模型优先以 `mode=baseline` 提交完整底稿；如需改写，只能按 `paragraphId` 提交文字补丁，不能删除章节、问题、表格、证据或人工复核标记。

严格 Rubric 不以“证据 ID 存在”作为通过条件。每条报告主张还必须能定位到原系统记录字段，证据原始值必须与主张值一致；趋势和排名分档等派生结论必须绑定参与计算的全部字段证据。严格通过要求可变句通过率、主张核验率和来源追溯率均为 100%，且无未支持主张。

DeepSeek 实跑可在 Pi 认证目录配置 `deepseek` 凭证，并选择 `deepseek-v4-flash`。密钥和本地 `.pi/settings.json` 不得写入仓库。

## 目录结构

```text
packages/task-runtime/
├─ src/audit-report/                 # 数据接入、事实包、报告生成、Rubric和Pi运行时
├─ skills/audit-report/              # 审计报告 Skill 及规则、数据源契约
├─ test/audit-report/                # 审计报告专项测试
├─ fixtures/audit-report/            # 模拟Excel、任务输入及三类Word模板
├─ scripts/audit-report/             # Word渲染、人工报告对比及批量回放脚本
├─ examples/audit-report/            # 已核验的生成报告示例
└─ docs/audit-report/                # 需求、字段来源、处理逻辑和前端流程说明
```

## 生产边界

- 只生成待人工复核草稿；
- 不修改源系统；
- 不自动发布、盖章或归档；
- 离任结论、否定性风险结论和人工覆盖字段必须保留人工确认；
- 当前 HTTP 服务是接口契约模拟，不是东方证券生产系统；上线时替换 API base URL 和认证适配器，保持归一化契约不变；
- 历史报告批量回放只验证事实恢复和模板生成能力，不属于未见数据盲测；
- 真实上线前必须使用未参与规则编制的新营业部留出集测试。
