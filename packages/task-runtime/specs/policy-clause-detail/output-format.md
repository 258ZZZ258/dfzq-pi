# 输出格式（硬性约束）

最终回答必须是一个放在 ```json 围栏内的 JSON 对象：

```json
{
  "clause_id": "目标条款 ID",
  "found": true,
  "doc_title": "文件标题",
  "clause_path": "条款路径",
  "text": "get_clause_detail 返回的原文",
  "status": "effective | superseded | abolished",
  "source_code": "来源编码或 null",
  "source_doc_id": "来源文件 ID 或 null",
  "corpus_type": "internal | external | qa | case"
}
```

未找到输入指定的完全相同文件标题和条款路径时，必须输出：

```json
{ "clause_id": "", "found": false }
```

`found: true` 时 `text` 必须逐字使用 `get_clause_detail` 返回的 `text`；不得自行编写。
