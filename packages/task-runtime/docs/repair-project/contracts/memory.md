# 记忆 HTTP / DB 契约 v1

状态：pi已实现，本地HTTP与worker已验；外部Java/PG/embedding待对接。入口挂在/memories，继承X-Internal-Token。X-Tenant-Id和X-User-Id同时必填，各不超过256字符；来自可信Java身份上下文。sessionId可选，缺省为用户长期桶，提供则为会话桶。租户/用户不能由模型指定。时间Unix毫秒。

| 方法路径 | 请求/结果 |
|---|---|
| GET /memories?sessionId=s&q=问题 | 可省略q列举；返回{version:1,items:[]}，不返回embedding |
| POST /memories | 用户可信写入，返回{version:1,item} |
| POST /memories/proposals | 模型候选，仍返回item，需approve |
| POST /memories/{id}/approve | {revision,sessionId?} |
| POST /memories/{id}/revise | {revision,text,sourceRef?,sessionId?} |
| POST /memories/{id}/delete | {revision,sessionId?}，返回{deleted:true} |
| POST /memories/compact | {ids,summary,requestId,sessionId?}，ids最多20，生成candidate |
| POST /memories/prune | {retentionMs?,sessionId?}，默认30天，返回{removed} |

```json
{"requestId":"memory-write-001","sessionId":"s","text":"回答先给结论，再解释证据","category":"preference","sourceRef":"user-setting","conflictKey":"answer-style","expiresAt":1900000000000}
```

requestId/text必填，text非空最多4000字符；category为fact/preference/summary，source由路由指定；sourceRef最多1000，conflictKey最多256，expiry可省略。body上限64KiB。同scope/requestId异参409，revision不符409；参数422，畸形JSON400，存储异常500。不要因500自动创建不同key的重复记忆。完整actor须同样用于/runs，否则无记忆上下文。

## 数据库格式

共用agent_state CAS端口，state_key为JSON字符串["memory",tenantId,userId,sessionId或null]，整桶写入并revision+1。默认200条，CAS竞争最多8次后memory_busy，不静默覆盖。

```json
{"version":1,"entries":[{"id":"random-uuid","requestKey":"hash(scope,requestId)","revision":1,"fingerprint":"hash(input,dependencies)","status":"active","text":"回答先给结论，再解释证据","category":"preference","source":"user","sourceRef":"user-setting","conflictKey":"answer-style","createdAt":1800000000000,"updatedAt":1800000000000,"embedding":{"model":"optional-model-id","values":[0.1,0.2]}}]}
```

可选expiresAt、supersededBy、dependencies:[{id,hash}]。状态candidate/active/superseded/deleted。embedding最多4096有限数值，只同模型比较；向量失败仍可词法检索。摘要审批时再次检查依赖；删源级联清空摘要正文/来源/向量。旧任务记录/备份不在该逻辑删除接口的物理擦除范围。prune后旧ID不复用；写入幂等仅在保留窗口内保证。

检索最多20条、服务文本上限12000字符；Runtime还限制到3000或模型窗口四分之一，并保留whole entry。检索后重新验证revision；resume前assertCurrent。头部身份仍须由Java网关认证，内部token本身不区分终端用户。
