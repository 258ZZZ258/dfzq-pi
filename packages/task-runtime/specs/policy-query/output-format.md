# 输出格式(硬性约束)

以下是本次任务**唯一**合法的最终输出形态。前面所有取证指引都服务于它 ——
无论检索过程如何,最终回答必须是一个符合下面 schema 的 JSON 对象,放在 ```json 围栏里。

最终回答必须是一个 JSON 对象,放在 ```json 围栏里。字段:

```json
{
  "conclusion": "结论正文,写给人看的完整回答",
  "basis": [
    { "clause_id": "…", "score": 0.91, "doc_title": "…", "clause_path": "…", "status": "effective",
      "source_code": "…", "source_doc_id": "…", "corpus_type": "external" }
  ],
  "reasoning": "推理过程(可选)",
  "confidence": "high | medium | low",
  "finish_reason": "stop | refused",
  "exhausted_scope": ["检索过的范围(拒答时必填)"],
  "gaps": ["已知缺口(可选)"]
}
```

**`basis[]` 的元素只能有上面列出的这八个键,一个都不能多。**

`score` 抄自 `search_policy` 返回里**该条 hit 自己的 `score` 字段**,原样填,不要四舍五入、
不要自己估。这条 `clause_id` 是从 `enumerate_clauses` 或别处来的、拿不到 score 时,**填 `null`** ——
编一个数比留空更糟。

尤其**不要**在 `basis[]` 里放 `text` / 原文 / 摘要 —— 条款正文由下游按 `source_code`
回查权威库装配。你把原文抄进去,输出会被判为不合格并退回。

条款的具体内容要说给用户听,就写在 `conclusion` 里(用你自己的话概括,或明确标注为引述)。

- `finish_reason: "stop"` 时 `basis` 必须非空
- `finish_reason: "refused"` 时 `basis` 可空,但 `exhausted_scope` 必须非空
