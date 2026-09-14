# 监督分析缓存、核验与编辑

## 字段核验

`verifyAndConvertExtractions` 将 audit-ai 返回的拒绝原因保留到问题、整改和问责记录的 `reviewReasons`，缺失必填字段、日期异常分别说明。`PENDING_REVIEW` 仍不纳入确认统计。模型否定结论不通过反复重试变成肯定。

## 编辑后引用复核

`editSupervisionReportDocument(document, expectedContentHash, edits, origin)` 接收服务端保存的文档包，编辑项仅包含 nodeId/text。结构、来源列表、证据编号保持原有绑定，正文变化后标记 `RECHECK_REQUIRED`，无引用仍为 `NO_SOURCE`。重复节点、不可编辑节点和旧内容版本拒绝。`origin=REGENERATION` 拒绝覆盖 `editedByUser=true` 的段落。

`recheckSupervisionReportDocument(document, expectedContentHash, evidence)` 使用原段落 lineage 的全部 evidenceIds，从调用方提供的已授权快照证据集合取得原文。每条证据必须匹配原资料版本。内部调用 audit-ai verify-fields，逐段判断修改后的文字是否得到原文支持；通过恢复 LINKED，不通过保留 RECHECK_REQUIRED 和 citationReviewReason。只有资料名而无原文证据的段落不能自动复核。没有证据时不会让模型猜测。

返回新的 contentHash；保存者必须在最终写入时再次比较此前的 contentHash，避免异步核验期间覆盖别人修改。本模块提供纯文档操作与模型复核函数，不实现 Java 保存接口、数据库事务或前端按钮。证据集合应由服务端读取，不能信任前端任意传入的原文。超过核验接口单段长度限制时明确失败，不截断。

## 验证

包目录运行：

```sh
node ../../node_modules/vitest/dist/cli.js --run test/supervision-report-document.test.ts test/supervision-extraction-bridge.test.ts
```

覆盖版本冲突、人工编辑保护、错误证据、核验否定结论、原因保留及对外 JSON schema。
