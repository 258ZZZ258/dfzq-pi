# 最终输出

最终回答只能包含一个 `ReportDraft` JSON 对象，并放在 `json` 代码围栏中。

- 输出必须是 `generate_report_draft` 返回的完整结构；需要语义修订时，以 `revise_report_draft` 返回为准。
- 不得输出取数过程、内部匹配推理、rubric 分数或额外说明。
- `status=needs-input` 时必须保留全部 blockers，不得擅自改为 ready-for-review。
- 每个可变事实必须保留对应 evidence ID。

