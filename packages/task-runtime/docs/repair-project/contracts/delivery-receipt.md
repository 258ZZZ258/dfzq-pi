# O2/O3 delivery v1

pi生产校验器生成delivery并与result同次finish写入。只证明结构校验与当前输出的绑定，不证明事实正确，也不是签名。

```json
{
  "version": 1,
  "validation": "schema_passed",
  "schemaHash": "64位十六进制SHA256",
  "outputHash": "64位十六进制SHA256",
  "partial": "none"
}
```

schemaHash绑定加载的Schema JSON；outputHash绑定runId、specId、status、output、limit、errorMessage、validation和schemaHash。数据库重开后恢复同一凭证；绑定不符或凭证损坏时，HTTP返回error/output_integrity_mismatch且不给answer。此读时降级不偷偷改写历史数据库行。

validation取值：schema_passed、schema_failed、not_requested（新文本任务无契约）、not_checked（未进入结构验证）、legacy_unverified（旧记录无凭证）。旧记录不被当前Schema重新认证。Java必须看validation，不将legacy_unverified当schema_passed。

失败元数据示例：

```json
{ "version": 1, "validation": "not_checked", "partial": "diagnostic_only", "error": { "code": "max_turns", "retryable": false } }
```

代码集：cancelled、max_turns、run_timeout、assembly_timeout、output_contract_invalid、output_contract_validation_error、result_identity_mismatch、output_integrity_mismatch、runtime_error。partial只为none或diagnostic_only，失败output不能作为经过校验的部分业务答案。retryable=false表示不得自动重试；人工重新发起不等于副作用幂等。

## 持久化

RunStore.finish(runId,result,finishedAt)新增result.delivery字段，映射delivery_json。SQLite自动添加nullable TEXT；PostgreSQL需要预先应用migrations/002-delivery-receipt.sql增加nullable JSONB，迁移仅生成未执行。markError和启动恢复会重新生成not_checked失败凭证，避免把当前新错误伪装为历史无凭证；PG在行锁事务中同步写入。历史NULL保留为未验证，不回填假成功。

Java终态响应增加可选delivery对象；既有status/output/answer/sourceDetails路径保留。非终态响应不增加凭证。数据库/Java实现仍由对接方完成；pi端类型、写入适配和本地重开/HTTP一致性测试已覆盖。

附加可选观测：judgeAttempts（repair计数）、memoryObservation（used/empty/unavailable与ids）、telemetryIncomplete（硬终止观测不全）；这些字段随delivery_json保存并恢复，但不参与outputHash，不可把它们当签名审计数据。
