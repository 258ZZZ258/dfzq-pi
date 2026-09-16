# Java → Pi 签名授权契约 v1

状态：Pi验签/HTTP/工具/执行期接线已实现，本地验证；独立复核完成。Java签发、TLS和真实PG部署不在本次外网执行范围。

## 生产配置与请求

CLI要求TASK_RUNTIME_AUTH_CONFIG指向受信JSON，缺失拒绝启动。配置结构为{issuer,audience,keys:{kid:公钥PEM},maxLifetimeSeconds?}；默认寿命300秒，上限配置3600秒。keys支持多个kid用于轮换，私钥只由Java保存；固定RS256、RSA≥2048bit、typ=pi-grant+jwt。不接受令牌指定远程公钥URL或任意算法。配置更新需重启加载；无新增依赖。

每个保护请求同时带X-Internal-Token和Authorization: Bearer <Java签名grant>；healthz例外。严格模式从已验签sub/tenantId派生身份，忽略外部裸X-User-Id/X-Tenant-Id。Pi不接受模型填写authorization、memoryScope、conversation或interaction保留选项。

```json
{"iss":"java-auth","aud":"pi-runtime","sub":"user-1","tenantId":"tenant-1","sessionId":"session-1","grantId":"grant-001","policyVersion":"42","iat":1800000000,"exp":1800000300,"actions":["run:create","run:read","run:steer","run:follow_up","run:renew"],"taskKinds":["policy-query"],"tools":["search_policy","get_clause_detail"],"dataScope":{"corpusTypes":["internal"],"permTags":["department-a"],"includeSuperseded":false}}
```

iat/exp/nbf是JWT秒；其余数据库/响应expiresAt等时间为毫秒。issuer/audience、身份/会话、grantId/policyVersion、actions/taskKinds/tools/dataScope必填。actions仅显式枚举，不支持通配符；tools可空（不会自动授予工具），corpusTypes和permTags必须非空。授权缺省不是不限。scope额外支持projectId/owner固定约束。

## 操作权限

| 入口 | action |
|---|---|
| POST /runs | run:create |
| GET /runs/{id}、GET消息 | run:read |
| cancel、DELETE授权 | run:cancel |
| resume | run:resume |
| POST授权续期 | run:renew |
| steer / follow_up消息 | run:steer / run:follow_up |
| GET记忆 | memory:read |
| 写入/修订/删除/候选/压缩/清理记忆 | memory:write |
| 批准候选 | memory:approve |
| 文档目录 | library:read，且必须含对应internal/external corpus |

principal_json独立保存{tenantId,userId}；严格边界对历史NULL拒绝访问，不凭某个用户发来的头自动认领旧任务。clientRequestId存储键和Gate会话键按tenant/user命名空间散列；外部sessionId仍保持原字符串。查询/恢复还核对scopeHash，权限或policyVersion变化时拒绝复用旧上下文/结果。取消不要求旧数据scope相同，但仍要求相同actor、session、taskKind和run:cancel。

请求filters只用于缩小已签名授权范围。corpusTypes/permTags求交，空交集拒绝；projectId/owner不能突破签名固定值；includeSuperseded只有请求与grant同时为true才开启。MCP和模型工具白名单同时受grant.tools限制，实际工具发出前和返回时复查执行授权。工具/检索服务仍需在数据库侧执行过滤，Pi不替外部服务作已部署保证。

## 长任务续期与撤销

POST /runs/{id}/authorization：请求携带新签名grant，不接受body授权声明；需run:renew。只接受同actor/session/dataScope/tools/policyVersion的延长，不能借续期改变正在运行任务的权限。返回{renewed:true,expiresAt:毫秒}。新凭证不必相同grantId；旧/更短有效期不覆盖较新记录。

DELETE /runs/{id}/authorization：需run:cancel，返回202 {revoked:true}。撤销对root job持久生效，不能再续期或通过原job resume绕过；若需新授权重新执行，应创建新任务并重新核验副作用。普通cancel仍是执行取消，不等于永久授权撤销。

宿主每秒检查授权租约；模型派发、工具调用、检查点保存和结果确认分别复查。不响应的worker由宿主取消/硬终止。Java必须在到期前续期或主动撤销；Pi没有Java业务数据库直连，也不能自动发现尚未通知Pi的角色变化。授权读取失败也停止，不按旧快照无限运行。

## 数据库端口

迁移004新增task_runs.principal_json JSONB；SQLite测试对应TEXT。原options_json中authorization存已验签claims用于审计/上下文绑定，不存原始Bearer字符串。不是密码或私钥存储。

agent_state key为JSON字符串["grant-lease",rootRunId]，使用已有CAS revision：

```json
{"version":1,"scopeHash":"sha256-of-actor-session-policy-tools-dataScope","grant":{"iss":"java-auth","aud":"pi-runtime","sub":"user-1","tenantId":"tenant-1","sessionId":"session-1","grantId":"g2","policyVersion":"42","iat":1800000100,"exp":1800000400,"actions":["run:renew"],"taskKinds":["policy-query"],"tools":["search_policy"],"dataScope":{"corpusTypes":["internal"],"permTags":["department-a"]}},"revoked":false}
```

示例只表示字段形状，scopeHash必须与真实grant匹配，不直接拿样例写库。grant读取不替代入口验签，只有受信宿主可写该表。无签名的嵌入式createApp测试保留旧内部token模式；默认生产CLI没有该降级开关。原服务监听127.0.0.1；Java远程接入由内网TLS代理配置完成。

错误：无效凭证401，动作/身份/范围不符403，参数422；范围变化/过期执行终态记录authorization_*原因，不自动重试外部写入。PG迁移仅生成未执行。

## 工具服务必须消费的权限字段

严格模式MCP请求由宿主覆盖tenant_id、user_id、project_id、owner、perm_tags、corpus_types、include_superseded和run_id；模型不能覆盖。project_id/owner缺省以null表示授权未进一步限定，include_superseded缺省false。工具服务必须在资源访问层落实这些字段，并拒绝不支持的授权限制；Pi的注入测试不代表内网检索服务已经实现。不得静默忽略tenant或project限制后返回更大范围数据。

production startServer使用databaseUrl时同样要求grants验签器，在任何IO前拒绝缺失配置；不只CLI做检查。个人记忆的memory:read表示允许读取该用户自己的记忆，并非自动重新计算所有历史记忆内容涉及的文档ACL；领域敏感派生内容应由外部策略决定是否进入个人记忆。
