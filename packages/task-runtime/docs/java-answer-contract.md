# task-runtime → Java 当前应答契约

状态：pi已实现，本地安装包/HTTP/worker验证；内网Java与PG部署待对接。业务answer形状由对应RuntimeSpec的outputContract定义。当前接入以本契约及runtime子契约为准。

## 请求与身份

生产POST /runs必须同时带X-Internal-Token与Authorization: Bearer <Java签名grant>。Pi从验签claims派生tenant/user/session，忽略裸身份头；任务归属独立保存principal_json。署名、动作和范围格式见repair-project/contracts/authorization.md。只有本地嵌入式无grants测试保留旧内部token模式；生产数据库模式缺验签器拒绝启动。主体示例：

```json
{"taskKind":"policy-query","input":"用户问题","clientRequestId":"intent-001","sessionId":"session-001","filters":{"corpusTypes":["internal"]},"options":{"topK":8}}
```

taskKind/input/clientRequestId/filters按请求Schema校验；sessionId可省略由宿主创建。clientRequestId是提交幂等键，同键异参409；options.resumeFrom/memoryScope保留给宿主，客户端传入422。执行无Token/费用预算，maxTurns由可信Spec控制；timeout和cancel处理运行可靠性。

## 返回与消费顺序

| 端点 | HTTP / 语义 |
|---|---|
| POST /runs | 200终态；waitMs内未结束202 {runId,status}，后台继续 |
| GET /runs/{id} | 200终态或{runId,status,progress?}；无记录404；actor不符403 |
| POST /runs/{id}/cancel | 202只确认取消意图；已终态409；未找到404，继续GET确认停止 |
| POST /runs/{id}/resume | 新attempt，200终态或202 {runId,status,resumedFrom}；细节见恢复契约 |

先判断status。queued/running继续轮询；completed才读answer，其余aborted/limit_exceeded/error为非成功终态。不要自行把output解析为成功结果。

终态RunResult字段：runId/specId/status、turns、durationMs、usage、judgeAttempts；可选output/errorMessage/stopReason/limit/sourceDetails/answer/delivery/memoryObservation/telemetryIncomplete。limit仅maxTurns或runTimeout。usage包含input/output/cacheRead/cacheWrite/total/cost，纯观测，内网无费用时cost为0。硬杀后usage/turns可能只剩下界，telemetryIncomplete=true，禁止用0推断无调用。durationMs同步返回运行计时，查库为finishedAt-startedAt挂钟差，不能保证二者精确相等。恢复turns延续原job已用轮数。

judgeAttempts现在写入delivery_json，轮询/同键重放会恢复；没有receipt的历史行回{}。它不是工具调用次数，工具对账仍用账本和事件。sourceDetails是顶层字段，不注入answer破坏schema。

## 校验与失败

输出先经运行时judge和有限repair，再由宿主按声明schema验证身份/JSON/Schema，然后等待事件落库、保存终态与delivery receipt。toWireResult校验receipt绑定，清除预填answer，只从completed的output提取对象或数组。未声明schema的纯文本任务可以completed而没有answer；旧行validation=legacy_unverified，不补签历史有效性。

```json
{"runId":"attempt-1","specId":"demo","status":"error","errorMessage":"event_persistence_failed","turns":0,"durationMs":10,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0,"cost":0},"judgeAttempts":{},"delivery":{"version":1,"validation":"not_checked","outputHash":"由pi生成的sha256","partial":"none","error":{"code":"runtime_error","retryable":false}}}
```

delivery.validation取schema_passed/schema_failed/not_requested/not_checked/legacy_unverified；schemaHash和outputHash供配置/交付绑定，不是数字签名或业务真实性证明。失败code包括cancelled/max_turns/run_timeout/assembly_timeout/output_contract_invalid/output_contract_validation_error/result_identity_mismatch/output_integrity_mismatch/runtime_error。event_persistence_failed、checkpoint_*、tool_outcome_unknown等详细原因在errorMessage；Java不能根据runtime_error自动重复执行写工具。partial=diagnostic_only仅表示保留诊断文本，绝非可消费的部分成功。

新版落库字段与迁移：[delivery receipt](repair-project/contracts/delivery-receipt.md)。[恢复/数据库JSON](repair-project/contracts/resume.md)、[记忆HTTP/数据库JSON](repair-project/contracts/memory.md)、[工具副作用协议](repair-project/contracts/atomic-state-tools.md)。

## 路径选择

非durable嵌入式工厂仍可按Spec fastPath运行，升级共享maxTurns和usage；取消后不再升级或repair。默认serve启用持久恢复时统一走完整Session路径，避免fast阶段缺失checkpoint，不声称同时享有快路径加速。专用业务workflow仍保留自己的确定性逻辑，未自动支持Session恢复。没有新增SSE或业务四态接口。

## 用户插入与追问

POST/GET /sessions/{sessionId}/messages接收及分页查询消息；steer留在当前run，follow_up创建独立run。POST/DELETE /runs/{id}/authorization负责同权限续期和持久撤销。详见[消息契约](repair-project/contracts/session-messages.md)和[授权契约](repair-project/contracts/authorization.md)。新增迁移004仅交付，尚未执行。

此分支不提供自优化反馈接口；授权动作中不包含run:feedback。报告类任务durableSession=false，不自动续跑或排队追问。Python服务位于services/audit-ai，默认路径由宿主解析。
