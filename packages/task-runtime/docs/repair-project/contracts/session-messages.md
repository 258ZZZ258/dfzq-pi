# 三端消息与对话状态契约 v1

状态：Pi收件箱/worker/新run追问已实现，本地活跃与重启场景通过；独立复核完成。原生steer语义在执行边界生效，不强行撤销在途工具；follow_up由宿主安排同session新run，避免多个答案压成一个终态。

## Java API

POST /sessions/{sessionId}/messages，必须使用签名grant；path session与grant匹配，目标run归属、taskKind、scopeHash均校验。所有请求继承内部token和body大小限制。

```json
{"clientMessageId":"m-001","kind":"steer","targetRunId":"run-123","text":"只分析2024年的资料"}
```

```json
{"clientMessageId":"m-002","kind":"follow_up","afterRunId":"run-123","text":"解释刚才的第二点"}
```

只允许上例字段。clientMessageId最多256字符、text非空最多8000字符；steer必须targetRunId且不能afterRunId；follow_up相反。返回202确认持久接收，并包含messageId/clientMessageId/sequence/kind/status及目标run。重复同键同内容返回同一messageId；异参409。任务已封口的steer返回409 run_not_active，不偷偷转为追问。队列满429。

GET /sessions/{sessionId}/messages?afterSequence=0 返回{items,nextSequence}，每页最多50，条目只返回外部字段；不返回grant/fingerprint/owner/完整conversation。前端经Java轮询该接口，SSE不在本次范围。

状态queued=已持久接收；dispatching=宿主领取追问；scheduled=新run已创建但尚未消费；consumed=消息进入执行上下文且checkpoint成功；blocked=过期/前置失败/已停止等明确不能消费。追问条目最终带独立runId，Java继续按runId读取答案。新run使用独立maxTurns；同run插入和故障resume不重置轮数。

## 存储与竞争

agent_state key为JSON字符串["inbox",tenantId,userId,sessionId]。整桶通过已有CAS revision提交，接收与封口共用同一状态行。最多64待调度消息、1000条保留消息，每条正文有限；对话快照最多2MiB。达到保留上限须另建会话或按运维保留策略归档，不能无界增长。

```json
{"version":1,"grant":"已验证claims对象，见authorization.md","nextSequence":8,"active":{"runId":"attempt-2","rootRunId":"run-123","accepting":true},"messages":[{"messageId":"uuid","clientMessageId":"m-001","kind":"steer","targetRunId":"run-123","text":"只分析2024年","sequence":7,"status":"queued","grant":"已验证claims对象","fingerprint":"sha256","createdAt":1800000000000}]}
```

例中grant用说明占位，真实值为对象。consumedCheckpointSeq由宿主保存checkpoint后填写；状态包括last终态、conversation以及终态前暂存staged对话。conversation={version:1,messages,scopeHash,memoryRefs}；这是下个任务的上下文，不是原任务恢复指针，不继承轮数和repair计数。

消息执行顺序：入库→worker在轮次边界读取→Pi steering队列→消息进入Agent上下文→checkpoint包含consumedMessageIds→宿主CAS保存→更新inbox确认→IPC ack。若checkpoint已存而ack丢失，恢复先以快照消费ID对账，不再次注入。不能用“入了worker内存队列”来确认消费。

终态封口时，如果仍有已接收的steer，就继续执行并重新校验输出；停止/耗尽时剩余消息blocked。输出校验和事件drain后保存会话投影，runs结果落库与runtime释放后结束active；可恢复孤儿状态与原host租约对齐。

追问领取使用60秒owner租约；跨副本共享CAS，创建新run使用确定性内部clientRequestId=follow-up:messageId并再做租户命名空间映射。派发失败或重启不另造新幂等键。调度器每500ms分页扫描100个session，单会话串行；句柄关闭时停止调度。

权限或policyVersion变化拒绝重用旧conversation；引用记忆失效也拒绝。专用业务workflow不启用交互状态，不能把通用Session恢复套到其业务过程。下游写工具未知窗口仍由工具账本决定，不因消息重发就重做副作用。

## 故障窗口补充

steer接收时绑定宿主生成的executionRoot。系统error保留尚未消费的queued消息等待原root恢复；同会话新建的无关run不能读取这些消息。明确cancel/限额会将对应root未消费消息标blocked。Runtime错误只pause封口，恢复重新打开；不会把每种故障都当用户取消。

actual worker测试已覆盖checkpoint提交前和提交后分别故障、服务/状态库重开、新worker resume，最后再创建追问；三种场景均保持插入文本一次、新run历史完整，追问turns=1且usage不重复累计历史模型调用。新追问的usageBaseline也进入checkpoint，恢复时沿用。

消息自己的签名授权快照有有效期；到期消息明确blocked，不因某个run续期就悄悄获得永久派发资格。新授权下重新提交应使用新的clientMessageId，旧消息保留审计状态。follow_up前置任务失败时blocked，不能将失败当成成功答案继续。
