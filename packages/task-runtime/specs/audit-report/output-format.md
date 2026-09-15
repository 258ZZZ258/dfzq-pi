# 最终输出

最终回答只能包含最新生成或成功修订工具返回的 `audit-report-result-ref.v1` JSON 对象，并放在 `json` 代码围栏中。保留 schemaVersion、taskId、documentToken 三个字段，不得添加字段。

- 模型不复述完整文档。Pi 在终局校验前将本次引用解析为完整 audit-report-document.v1；所有原有完整文档校验仍执行。不得猜测 token 或复用旧 token。
- `report` 是完整审计报告底稿；`nodes` 是保序节点列表；段落节点的 `nodeId` 等于 `paragraphId`。
- 段落节点通过 `citationIds` 关联统一的 `citations` 目录。不得自行增加、删除或改写依据，不得输出匹配度。
- `structureHash` 只校验结构和样式引用，单独修改段落文字时必须保持不变。
- 不得输出取数过程、内部匹配推理、rubric 分数或额外说明。
- `report.status=needs-input` 时必须保留全部 blockers，不得擅自改为 ready-for-review。
- 每个可变事实必须保留对应 evidence ID。
