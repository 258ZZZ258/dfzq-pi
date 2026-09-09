# 报告流程联调说明（2026-09-09）

## 1. 本次实现范围

本次仅修改 Pi 的 `packages/task-runtime`。Java 端由 Java 同事负责，本文涉及 Java 的业务流程和接口是待双方确认的对接建议，不代表已实现。未修改 Java、audit-ai、前端页面及现有营业部主表。

Pi 已支持接收业务快照、校验流程状态和来源版本、按三类报告生成文档包。快照保存、征求意见匹配、反馈及处理落库由 Java 实现。Java 应组装 `AuditReportDataset`，不能直接让业务人员填写证据字段等技术字段。前端表单到主表、主表到 dataset 的实际字段映射需由 Java 同事落实后联调。

## 2. 三种报告

| 类型 | 输出 | 生成条件 |
|---|---|---|
| consultation | 征求意见书：基本情况、本次问题、反馈及整改计划要求 | 数据完整；反馈期限和要求已填写；不要求提前收到反馈 |
| regular，独立 | 常规正文＋同文件反洗钱附件 | 已查询且不存在对应征求意见书；不写已收到反馈 |
| regular，关联 | 常规正文＋同文件反洗钱附件 | 对应征求意见书已反馈且逐项审计处理完成；复用生效快照 |
| turnover | 离任审计报告 | 任免和负责人数据、18项业务检查等完整；负责人反馈已完成 |

Java 需在实际项目成员授权范围内匹配：同营业部、同审计期间为基础，项目优先，其他项目同区间兜底；优先候选取最新版本，未完成版本应阻断。常规草稿创建后，生成前需再次检查是否出现新轮次。Pi 只核验 Java 提供的 workflow，不能代替 Java 查询数据库确认候选是否完整。

## 3. Java 业务接口建议（待 Java 同事确认）

统一前缀 `/api/v1/audit/reports`，复用现有认证，拥有者从登录 Principal 获取，不接受请求自行指定 owner。

| 方法及路径 | 输入 | 结果 |
|---|---|---|
| POST / | 业务模块组装的 dataset | 新版本 DRAFT；后台分配 reportId、version、revision、workflow |
| GET /{id} | 报告ID | 当前快照、状态、版本、文档、反馈及处理结果 |
| GET /{id}/generation-input | 报告ID | Java→Pi 请求预览，后台联调用，不是业务填报界面 |
| POST /{id}/generate | 报告ID | 提交 Pi 任务，绑定 runId；进行一次状态查询 |
| GET /{id}/generation | 报告ID | 查询 Pi；仅 completed 且合法文档才保存为 GENERATED |
| POST /{id}/feedback | If-Match: 当前数字 revision；整体意见＋逐项意见 | 保存反馈，FEEDBACK_PENDING |
| POST /{id}/resolution | If-Match: 当前数字 revision；处理说明＋逐项处理 | 保存独立生效快照，RESOLVED |

`GENERATED` 表示生成成功、供审阅，不代表签发或业务最终批准。此补丁不提供原稿直接覆盖或正文在线编辑接口。

反馈请求：`{opinion:"agree|partly-agree|disagree", explanation:"...", items:[{findingId:"...", opinion:"...", explanation:"..."}]}`。异议必须说明原因；逐项集合完整、不重复。

处理请求：`{summary:"...", items:[{findingId:"...", action:"keep|modify|delete", reason:"...", finding:{...}}], evidence:[...]}`。modify 传完整修改问题，不能改变归属；keep/delete 不传 finding。补充证据使用新 ID，不能覆盖旧证据。原始 input/document/feedback 保留，effective 单独保存。修订后的事实证据应由后台同步生成，否则 Pi 核验不能把旧事实作为新事实依据。

常规复用：组织、人员、任免、经营指标、检查项、风险事项、问题及其证据来自 effective。仅报告日期、模板和落款等输出配置取新任务值。来源报告ID、文书版本、数据修订版本固化在 workflow。独立报告的数据不得被模型伪装成关联版本。

## 4. 部署与验证

1. Java 同事设计并实现报告版本、原始快照、生效快照、反馈及处理记录的持久化；本次不交付或执行 Java 建表脚本。
2. Java 配置 Pi 地址及内部鉴权令牌，调用时使用 `X-Internal-Token`；具体 Java 配置名由同事确定，不要提交密钥。
3. Pi 仍需可用的模型提供方及 audit-report spec。规则生成确定性内容，模型负责工具调用及必要改写；测试的 faux 模型不等于真实模型验收。
4. Java 发送 input.v2 快照及受限 internal 范围，Pi 报告工具只读取绑定数据，不提供自由SQL、任意路径或任意取数接口。
5. Pi queued/running 继续查询；其他非 completed 终态保留诊断结果，不存为正式可用文档。网络重试复用同一 clientRequestId；若已有任务失败需新建版本重试，不覆盖原始版本。
6. 需联合验收：主表组装真实 dataset、同项目多人权限、实际数据库迁移、真实模型、附件分页和 Word 样式、前端反馈交互及失败提示。

本地定向测试：Pi 执行 `npx vitest run test/audit-report-agent.test.ts test/business-data-contracts.test.ts`。当前19项通过，使用模拟HTTP与临时Excel验证取数边界，使用测试模型验证运行链路；不代表真实 Java 或模型联调通过。测试 fixture 仅用于回归，不是生产取数来源。
