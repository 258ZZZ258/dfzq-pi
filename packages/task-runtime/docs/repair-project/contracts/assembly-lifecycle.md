# 装配与释放契约（E2.1 / E2.2）

状态：pi Session/FastPath/MCP 路径已实现，本地故障测试验证；不涉及数据库/Java服务端实现。

## 数据流

Java POST /runs → RunManager准入 → 为任务创建 assemblyAbort → RuntimeFactory.signal → Session/FastPath 的 assemble → ToolsetRegistry.resolve(signal) → MCP initialize/tools/list。取消时 manager 先记录意图并 abort 装配信号；握手取消后客户端释放子进程，初始装配分支按 aborted 收尾。升级时创建 full 若因取消拒绝，也保留 aborted 而不是改报 error。

assemble 的 assemblyTimeoutMs 默认60000，来自 pi 工厂配置，非Java请求参数。超时信号与调用方信号组合；每次装配分别计时，完成后清除timer。初始装配超时保存 status=error、errorMessage=assembly_timeout；它不属于已经运行的 runTimeout，也不消耗模型轮数。

## 传给数据库

初始装配超时沿用 RunStore.markError(runId,message,finishedAt)：

```json
{ "runId": "r1", "message": "assembly_timeout", "finishedAt": 1800000001000 }
```

适配映射为 status=error、error_message=assembly_timeout、finished_at；无需新列。取消沿用 RunStore.finish(runId,result,finishedAt)，result.status=aborted、turns=0，usage六字段为0，judgeAttempts={}；升级装配取消则保留快路径已完成的turns/usage。

signal、AbortController、清理Promise是进程资源，不序列化到请求、数据库或Java响应。旧schemaVersion未凭空增加；当前沿用既有RunStore与RunResult契约。

## Java 处理

取消接口继续返回202表示已受理，Java按runId轮询终态；握手回收完成后才能看到aborted。超时最终读到error和assembly_timeout，不能解释为maxTurns；不要用自然语言正文判断是否成功。装配没有新增Java参数；恢复另见resume.md，标准失败字段另见delivery-receipt.md。后续O3已为装配错误/取消保存delivery_json失败凭证。

## 资源释放

disposeOnce 尝试所有独立清理动作，支持同步抛错及异步拒绝。重复/并发dispose共享同一完成结果，不重复清理。单个失败保留原异常，多个失败使用AggregateError；MCP部分启动失败同时保留原始启动异常和清理异常。它保证尝试每个动作，不保证失败的资源已经成功回收。

MCP子进程沿用SIGTERM→等待→SIGKILL的有限清理。清理动作并行，各资源必须独立；不得把有先后依赖的事务步骤交给disposeOnce。

## 隔离层与边界

本节是嵌入式协作deadline。默认serve现已在外层加入guardian/worker进程组硬截止，因此不响应signal或卡死JS可由宿主终止；详见isolated-worker.md和ADR0004。没有用Promise.race提前释放许可并遗留无主资源。业务工作流内部行为与恢复仍暂停，不以通用进程回收证明其业务可恢复。
