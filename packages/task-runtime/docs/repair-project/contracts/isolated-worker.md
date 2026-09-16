# E2 隔离运行协议

CLI serve使用createWorkerFactory。宿主fork独立进程组中的guardian，guardian不加载模型/插件，只转发IPC并监视父连接；实际运行时在其子进程加载。宿主取消宽限期、runTimeout或dispose超时后杀进程组，再等待退出；父连接断开时guardian回收同组进程，避免把Promise.race当资源回收。

```json
{ "version": 1, "id": 1, "method": "run", "payload": { "input": "原始请求", "runId": "attempt-id" } }
```

方法：init/run/abort/steer/followUp/waitForIdle/dispose，响应含同id的result或error。checkpoint使用负id请求，宿主持久化后回checkpoint_ack，未确认不能继续工具执行。单条IPC上限8MiB，环境仅传profile/Spec引用和必需运行变量，不继承宿主全量环境。

仅POSIX进程组支持，非恶意代码沙箱；主动逃离进程组/宿主权限攻击不在保证范围。硬中止后usage/turns可能缺少在途观测，结果增加telemetryIncomplete=true，随delivery保存，不能把零值当完整消耗。Java继续读status/limit/delivery.error.code，原始工具副作用是否已生效由E3账本unknown表达。

验证：卡死JS和其子进程在取消/超时后退出；实际已安装Pi工厂在isolated模式下最大轮数1/2/3受控。无需Java新增执行参数；运行历史接收RunResult及delivery，状态库另接收checkpoint/ledger，OS PID不作为持久业务身份。
