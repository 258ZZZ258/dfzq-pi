最终输出必须是单个 JSON 对象，符合 `supervision-analysis.v1` 输出契约。不要输出 Markdown 代码块、解释、
处理步骤或额外结论。`extractionRuleVersion`、`task`、`snapshot`、`issues`、`relations`、`statistics`、`readiness` 和
`reportOutline` 必须直接采用 `build_supervision_analysis_result` 工具返回值。
