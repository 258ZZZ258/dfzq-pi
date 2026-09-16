# 恢复与持久状态契约 v1

状态：pi已实现，SQLite本地重启链路已验；PG/Java实机外部待对接。producer是pi宿主/worker，数据库只接收规范JSON；时间均Unix毫秒。

## Java请求

POST /runs/{failedRunId}/resume，X-Internal-Token必填；原任务绑定actor时X-Tenant-Id、X-User-Id须相同。body仅允许：

```json
{"clientRequestId":"retry-attempt-02"}
```

completed任务拒绝恢复；仍活跃的任务由会话闸门或持久租约拒绝并行接管。新attempt返回200终态或202 {runId,status,resumedFrom}，随后GET轮询。不能传新input/filters/maxTurns/存储checkpoint；普通POST /runs也拒绝客户端resumeFrom/memoryScope。options.resumeFrom由宿主设置为首个job的runId，之后恢复仍沿用。每次新恢复意图用新clientRequestId，同键重发沿用原attempt；冲突不自动重试。

## DB原子端口

迁移003：agent_state(state_key TEXT PRIMARY KEY,revision BIGINT,value_json JSONB)。SQLite对应INTEGER/TEXT。不存在时expectedRevision=null，仅INSERT ON CONFLICT DO NOTHING；存在时UPDATE WHERE revision=expectedRevision，成功revision+1。返回false代表未获得所有权，禁止当成功继续。不得无条件UPSERT覆盖。

```json
{"version":1,"fingerprint":"sha256-of-config-and-input","owner":"random-owner-id","fence":2,"leaseUntil":1800000060000,"status":"running","checkpointSeq":3,"checkpoint":{"version":1,"kind":"pi-session","piVersion":"0.82.1","runId":"attempt-02","specId":"demo","configHash":"sha256","checksum":"sha256-of-canonical-snapshot","input":"用户原输入","turns":1,"next":"pending_tools","sessionJsonl":"完整Pi JSONL字符串","messages":[],"clauseIds":[],"sourceDetails":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0,"cost":0},"pluginState":{}}}
```

示例messages为空仅展示格式，真实pending_tools必须含稳定toolCallId和未消费调用；不能手工拼造恢复状态。state_key为JSON数组字符串["checkpoint",scopeHash,rootRunId]；会话锁复用同结构且runId为session-lock。next取pending_tools/continue/judge/repair；pluginState保存repair计数/待发提示、记忆引用、已有插件证据。checksum字段计算时排除自身。总消息不超过8MiB；版本/配置/权限/记忆不兼容直接error。

host键["host",hostId]值为{version:1,leaseUntil,activeRuns:[runId]}；归属键["run-owner",runId]值为{version:1,hostId}。缺归属先保留一个租约宽限期，失活才条件markStale。默认租约60秒，每约20秒续约；各副本时钟需同步。job只有在runs终态落库后才release(completed)，其他释放为paused。

持久工具状态见atomic-state-tools.md。检查点恢复不等于业务写事务回滚；unknown需下游核查，不承诺全局exactly-once。日志不是检查点。默认durable选择完整Session；不支持专用业务workflow的自动重建。
