# E3 状态CAS与工具操作账本

状态：pi端状态端口、SQLite/PG适配器和工具账本已实现；MCP/生产工厂可注入toolLedger。未配置时不宣称账本已启用。

StateStore.get(key)返回{revision,value}，compareAndSwap(key,expectedRevision,value)原子创建/更新，失败返回false。null仅代表从未创建；删除使用tombstone而不回退revision，防止旧写入覆盖新状态。JSON必须可序列化，不接受循环、函数和非有限数。PG需migrations/003-agent-state.sql，未执行实库迁移。

```json
{ "key": "[\"tool\",\"scope-hash\",\"run1\",\"call1\"]", "expectedRevision": null,
  "value": { "version": 1, "fingerprint": "sha256", "owner": "attempt-uuid", "status": "running", "leaseUntil": 1800000060000 } }
```

状态running/completed/failed/unknown。调用前先CAS占位，完成后以同一revision提交结果。重复相同callId且参数一致时重放已完成结果；参数或工具版本变化拒绝。租约未到期返回进行中。过期的非幂等写标unknown，不自动重做；幂等写只有在下游遵守idempotency_key协议时才允许重试并传同一个key。旧执行者失去revision后不能覆盖新结果。

toolEffects由可信MCP配置声明read/idempotent_write/non_idempotent_write，不由模型提供。启用账本时未声明effect或缺scope的调用会拒绝。工厂注入toolLedger，Spec摘要绑定工具版本，权限scope绑定操作。客户端内部工具调用ID只保护同一调用的恢复/重放；模型产生新的callId代表新操作，不能宣称跨业务意图的exactly-once，需要业务幂等键契约。

Java恢复入口已接入，见resume.md；unknown保留tool_outcome_unknown详细错误，delivery归入runtime_error且retryable=false。读取/写入所有权由CAS保证，网络服务副作用无法与本数据库事务原子提交，unknown状态是这个窗口的显式表达，不隐瞒为“失败后可随便重试”。
