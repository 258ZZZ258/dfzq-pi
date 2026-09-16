# O1 输出落库与Java交付契约

状态：生产startServer路径已实现结构兜底；仅pi代码改动，Java提供消费契约。

## 端到端路径

Spec目录加载→读取已声明的outputContract Schema→RunManager准入→运行时模型/工具与C6有限修复→宿主核对runId/specId并做最终结构校验→RunStore.finish→HTTP同步/轮询/幂等重放→toWireResult。

结构校验复用validateOutputShape，运行时validateOutputContract在它之上继续做既有证据/条件检查。最终关口只做结构检查，不重复解释制度或费用规则，不替代证据正确性评测。

## 输出出口矩阵

| 出口 | 处理 | 当前边界 |
|---|---|---|
| 新运行同步完成 | 校验后保存，再转换HTTP | startServer已注入validator |
| 等待窗口结束后读终态 | 从已保存status/output恢复 | 不重新生成或换当前Schema重判历史 |
| GET结果 | 同上 | 非终态保持等待 |
| 同键重放 | 同上，不再执行 | 相同任务仍指向同一run |
| 直接嵌入RunManager/createApp | 嵌入方需注入loadResultValidator | 默认无Schema信息，不能宣称已校验 |
| CLI | 继续由运行时C6处理 | 此次未新增CLI落库关口 |

## 状态与格式

- 声明契约的completed输出若缺失、解析失败或Schema不符，保存为error，errorMessage以output_contract_invalid开头；校验器异常为output_contract_validation_error。
- 返回的runId/specId与准入身份不同，保存为error/result_identity_mismatch，响应绑定原任务身份，不允许换Spec绕过校验。
- 未声明契约的纯文本任务仍可completed且没有answer，不把合法文本误当失败。
- answer始终重新从本次output提取，拒绝沿用预填answer；aborted/error/limit_exceeded不交付answer。
- 对象与数组保留根结构，损坏数组不得提取其内部对象冒充完整JSON。当前通用解析器支持对象/数组根；标量Schema不在本轮支持范围。

## Java字段调整（需同步消费方）

```json
{
  "runId": "r1", "specId": "demo", "status": "completed",
  "output": "{\"ok\":true}", "answer": { "ok": true },
  "sourceDetails": [{ "clause_id": "C1", "text": "原文" }],
  "turns": 2, "durationMs": 100,
  "usage": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": 2, "cost": 0 },
  "judgeAttempts": {}
}
```

不再注入answer.source_details，Java从已有顶层sourceDetails读取来源。这样answer与已校验的JSON深等，不在校验后增加违反additionalProperties的字段。数组answer原样为数组。此次不保留旧嵌套字段兼容；上线前需要Java消费方同步，未部署。

## 持久化格式

仍使用RunStore.finish(runId,result,finishedAt)，例如结构失败：

```json
{
  "runId": "r1",
  "result": {
    "runId": "r1", "specId": "demo", "status": "error",
    "output": "模型的原始不合规输出", "errorMessage": "output_contract_invalid: 未找到 JSON 块",
    "turns": 2, "durationMs": 100, "judgeAttempts": {},
    "usage": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": 2, "cost": 0 }
  },
  "finishedAt": 1800000000100
}
```

status/output/error_message按现有列保存，sourceDetails→source_details_json；answer由读取时重新提取，不新增列。没有schemaVersion新字段或预算数据。判断失败和原始output一同保存，不修改历史记录。

## 后续已完成能力

O2/O3已增加delivery_json、Schema hash、历史legacy_unverified、delivery.error.code和partial诊断语义，详见delivery-receipt.md。以上O1示例省略后续receipt字段；当前生产返回应以Java当前应答契约为准。不能由结构正确推断事实正确，也不能认为旧completed记录已通过新增校验。
