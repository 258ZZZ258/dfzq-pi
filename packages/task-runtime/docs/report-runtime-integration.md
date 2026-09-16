# 报告流程与主线运行时的接线

审计报告、披露关联与监督分析使用同一条 RuntimeSpec → ProviderProfile → ToolsetRegistry → SessionRuntime 链路。报告的叙述改写/独立复核子会话也沿用该链路，不直接调用模型客户端。

- 只用 `maxTurns` 控制模型回合发散。报告父会话和叙述子会话共享派发计数，在模型请求前扣除一个回合；失败的已派发请求也计数。没有费用或累计 token 预算。`runTimeoutMs` 为整条报告流程的时间上限，子会话不得超过剩余时间。
- Java 签名授权在装配、原生工具调用以及父子模型派发前校验。私有初始化/交付验证工具只供宿主调用，不进入模型工具白名单。取消信号传入 HTTP、文件读取、子会话装配及运行；同步工作簿解析仍由外层 Worker 强制终止机制兜底。
- 报告先返回内部引用，再由 `resolveOutput` 解析为证据绑定文档，之后执行最终判官。`beforeRun`/`resolveOutput` 都在公共运行时的异常与取消边界内。父流程修改状态或汇总子会话后重新封装交付回执，失败结果不作为成功答案交付。
- `audit-report`、`audit-disclosure`、`supervision-analysis` 保持 `durableSession:false`。这些任务的私有业务状态尚未纳入恢复契约，不能宣称支持断点恢复或队列式续问；通用运行时的其他任务仍保留这些能力。
- 每次报告的叙述复核记录写入该任务独立工作目录，包含 `audit-narrative-review.v1` 记录及 `audit-narrative-manifest.v1` 清单。文件权限为0600，不作为模型可见工具正文；数据库仍使用主线任务记录、交付回执与授权主体字段，不新增自优化反馈表。

任务回查使用 [run-reconciliation.md](run-reconciliation.md) 的租户/用户隔离请求键。数据库初始化统一遵循包 README 的 Alembic 路径；独立空库 SQL 不能与该路径重复执行。
