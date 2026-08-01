# task-runtime → Java 应答契约

适用范围:`POST /runs` / `GET /runs/:runId` 对 `taskKind: "policy-query"` 的返回体(`RunResult`,定义见
`packages/task-runtime/src/runtime/contract.ts`)。`RunResult` 的字段清单(§1)对任何 taskKind 都成立,但
`answer` 的具体形状(§2)是 `policy-query` 这一个 spec 的输出契约
(`packages/task-runtime/specs/policy-query/output-contract.schema.json`)决定的 —— 换一个 taskKind,`answer`
的形状会不一样。

---

## 0. 先看这条:`answer` 只在 `status === "completed"` 时出现

**消费 `answer` 之前必须先判断 `status`。** 只要 `status !== "completed"`(即 `"aborted"` /
`"limit_exceeded"` / `"error"`),响应体里**不会有 `answer` 字段** —— 不管 `output` 里能不能抠出语法合法的
JSON。

这不是保守起见的额外判断,而是一条真实踩过的坑:C6(输出契约判官,`onExhausted: "error"`)判定输出不合规时,
run 的终态是 `"error"`,但产生这份输出的助手文本仍然会**原样**写进 `output`。早先的实现只看 `output` 里能不能
抠出 JSON、不看 `status`,于是被 C6 拒掉的 JSON(实测样本 `basis[0].clause_id = "臆造-999"` —— 正是反幻觉
兜底要拦的那一类)会原样进 `answer`。现在 `toWireResult`(`packages/task-runtime/src/server/routes.ts`)的第一行
判断就是这道闸门:

```ts
export function toWireResult(result: RunResult): RunResult {
	if (result.status !== "completed") return result;
	...
}
```

⇒ **Java 侧的消费顺序必须是:先读 `status`,`status === "completed"` 才去读 `answer`;非 `completed` 时按
§3 降级。**

---

## 1. `RunResult` 完整字段

| 字段 | 类型 | 何时存在 | 说明 |
|---|---|---|---|
| `runId` | `string` | 恒有 | 本次 run 的唯一 ID |
| `specId` | `string` | 恒有 | 产生本次 run 的 spec id;`taskKind` 与 spec id 一一对应,Java 传 `taskKind: "policy-query"` 时这里回的也是 `"policy-query"` |
| `status` | `"completed" \| "aborted" \| "limit_exceeded" \| "error"` | 恒有 | 终态。见 §0、§3 |
| `output` | `string \| undefined` | run 产生过助手文本时有 | 原始助手文本,带 markdown 围栏,**未必是合法 JSON、未必通过 C6**。诊断/审计用,见 §6 |
| `errorMessage` | `string \| undefined` | 常见于 `status === "error"` | 人类可读的失败原因(判官拒绝详情、异常信息等) |
| `stopReason` | `string \| undefined` | 通常有 | 模型侧上报的停止原因 |
| `limit` | `"maxTurns" \| "runTimeout" \| "maxTotalTokens" \| "maxCostUsd" \| undefined` | `status === "limit_exceeded"` 时有意义 | 命中的限额种类 |
| `usage` | `{ input, output, cacheRead, cacheWrite, total, cost }`(均为 `number`) | 恒有 | token 用量与成本;`cost` 与 spec 的 `limits.maxCostUsd` 是同一口径(同一个数字直接比较) |
| `turns` | `number` | 恒有 | 本次 run 走过的轮次 |
| `durationMs` | `number` | 恒有 | 耗时(毫秒) |
| `judgeAttempts` | `Record<string, number>` | 键恒在,但**经 HTTP 拿到的值通常是 `{}`** | 见下方单独说明,不建议依赖 |
| `answer` | `unknown` | 仅 `status === "completed"` 且能从 `output` 提取出合规 JSON 时有 | 本文档主角,见 §0、§2、§3 |

**`judgeAttempts` 的 HTTP 侧陷阱**:这个字段设计上只服务进程内验收,不落库。终态结果有四个 HTTP 出口,其中
三个(`POST /runs` 的幂等分支、等待窗口超时后查库、`GET /runs/:runId`)都经 `recordToRunResult` 从落库行重建
`RunResult`,`judgeAttempts` 在这三条路径上恒为 `{}`;只有第四条 —— `POST /runs` 在 `waitMs` 窗口内同步拿到
完成结果的那条分支 —— 直接返回内存里算出来的 `RunResult`,这里才有真值。**Java 不应依赖 `judgeAttempts` 做
业务判断**,大多数请求路径上它都是空的。

---

## 2. `answer` 的形状(policy-query 的输出契约)

`answer` 的值来自 `output` 的 JSON 块,且已经过 C6(输出契约判官)按
`specs/policy-query/output-contract.schema.json` 校验通过(§3 说明"通过"具体保证了什么、没保证什么)。当前
唯一接入 Java 的 taskKind 是 `policy-query`,其 `answer` 形状:

```jsonc
{
  "conclusion": "string,非空,写给人看的结论正文",
  "basis": [
    {
      "clause_id": "string —— 必填,反幻觉兜底的唯一载体,见下方",
      "score": "number | null",
      "source_code": "string | null",
      "source_doc_id": "string | null",
      "clause_path": "string | null",
      "doc_title": "string | null",
      "status": "\"effective\" | \"superseded\" | \"abolished\"",
      "corpus_type": "\"internal\" | \"external\" | \"qa\" | \"case\""
    }
  ],
  "reasoning": "string,可选",
  "confidence": "\"high\" | \"medium\" | \"low\"",
  "finish_reason": "\"stop\" | \"refused\"",
  "exhausted_scope": ["string,可选;finish_reason 为 refused 时必须非空"],
  "gaps": ["string,可选"]
}
```

顶层必填(schema `required`):`conclusion` / `basis` / `confidence` / `finish_reason`。`reasoning` /
`exhausted_scope` / `gaps` 是可选键。

`basis[]` 每个元素**只强制 `clause_id` 必填**;其余七键在 schema 层面允许缺省或为 `null`
(`score`/`source_code`/`source_doc_id`/`clause_path`/`doc_title` 的类型是 `["number"|"string", "null"]`,
`status`/`corpus_type` 是没有 `null` 分支的枚举 —— 一旦给出就必须是列举的那几个值之一,但同样不是必填)。
`basis[]` 的元素**只能有这八个键**(schema 的 `additionalProperties: false`),不会多出别的字段 —— 比如条款
原文;契约正文(`output-format.md`)明确禁止把原文塞进 `basis`,原文由下游按 `source_code` 回查权威库装配。

`status === "completed"` 时,`answer` 还隐含两条业务规则(由 C6 强制,不在 JSON Schema 的 `required` 里,但
不满足就到不了 `completed`):

- `finish_reason === "stop"` ⇒ `basis` 非空;
- `finish_reason === "refused"` ⇒ `exhausted_scope` 非空;
- **反幻觉**:`basis[].clause_id` 必须是本次 run 真实检索到过的 clause_id 之一 —— 引用了本次检索结果之外的
  clause_id,C6 判失败,run 到不了 `completed`,`answer` 也就不会出现(见 §0)。

⇒ 当 `answer` 出现时,`basis[].clause_id` 的可信度是有保证的(通过了反幻觉校验);但 `basis[].score`
**不在这份保证范围内** —— 见 §4。

---

## 3. `answer` 缺省的四种情形与降级

`answer` 由 `toWireResult`(`packages/task-runtime/src/server/routes.ts`)在终态 `RunResult` 上现算,不落库、
不重新跑模型。共有四种情形会让它缺省:

| # | 情形 | 触发条件 | 对 `policy-query` 当前是否会出现 |
|---|---|---|---|
| 1 | **`status !== "completed"`** | `status` 是 `"aborted"` / `"limit_exceeded"` / `"error"`(含 C6 判定不合规、reprompt 次数耗尽那一类) | 会 —— 这是最外层闸门,见 §0 |
| 2 | `output` 本身是 `undefined`,或 `output` 有内容但挖不出花括号包裹的候选(`extractJsonBlock` 返回 `absent`) | 助手最终没产出文本,或产出的是纯散文,没有 `{…}` | 理论上不会:见下方说明 |
| 3 | 花括号配对但 `JSON.parse` 失败(`extractJsonBlock` 返回 `unparsable`) | 挖出的候选语法不合法 | 理论上不会:见下方说明 |
| 4 | **spec 未声明 `outputContract`** | 该 taskKind 对应的 `RuntimeSpec` 没有 `outputContract` 字段,C6 根本不会挂载(`session-runtime.ts`),`status` 可以是 `"completed"` 而 `output` 从未经过任何 schema 校验,#2/#3 才会真的发生 | 不适用 —— `policy-query` 的 spec 文件(`specs/policy-query.json`)声明了 `outputContract`。仓库里目前只有 `blackbox-eval` 这个 taskKind 走这条路,且不对 Java 开放 |

**#2/#3 对 `policy-query` 只是防御性表格项,不是已观察到的行为**:只要这个 taskKind 继续声明
`outputContract`(现状如此),`status === "completed"` 就意味着 C6 已经用同一个提取函数(`extractJsonBlock`)
验证过 `output` 里有语法合法、schema 合规的 JSON;`toWireResult` 之后用同一段 `output` 文本重新提取一次,
按设计应当得到同样的结果。写出 #2/#3 是因为 `toWireResult` 的代码路径本身允许这两种结果(它不知道、也不假设
调用方一定声明了 `outputContract`),不是因为已经在 `policy-query` 上观察到它们发生过。

**Java 侧降级建议**:

- `status !== "completed"`:不要读 `answer`(它不存在)。按业务判失败 / 转人工;需要诊断可以读 `output`,
  但 `output` 未必合规,见 §6。
- `status === "completed"` 但响应体没有 `answer` 键(#2/#3/#4 任一种):同样不要假设 `output` 里有可解析的
  结构;按业务判"取不到结构化应答",不建议自行重新解析 `output`(理由见 §6)。

---

## 4. `basis[].score`:诚实登记

> `basis[].score` 是**模型从 `search_policy` 的返回抄写的,不是检索器的真分**。中间隔着一层可能出错的抄写,
> 而且没有任何机制能验证它抄对了(审计日志按设计不记返回体,`run_events` 的脱敏投影只留
> `toolName`/`isError`)。**不要把它当权威相关性分用**;它可以为 `null`,取不到时请降级不显。

这条登记与 schema 本身的 `$comment`(`specs/policy-query/output-contract.schema.json`)以及契约正文
(`specs/policy-query/output-format.md`:"`score` 抄自 `search_policy` 返回里该条 hit 自己的 `score` 字段,
原样填,不要四舍五入、不要自己估……拿不到 score 时,填 `null`")互为印证 —— 三处说的是同一件事:这个数字的
可信来源止步于"模型抄对了没抄错",没有第二条独立取证路径能核对是否抄对。

Java 侧使用建议:可以展示,但不要用它做排序 / 筛选 / 阈值判断等把它当权威相关性分的用途;取不到(`null`)时
按缺省处理,不要编造。

---

## 5. 与 boundary v1 的差异 —— 这不是 boundary v1,不要按那套假设消费

本契约与 audit-ai 现有的 boundary v1 应答形状**不兼容,也不是它的子集或近似**。下表逐项列出差异,"本契约"一栏
是本文档实际描述的形状(§2),不是 boundary v1 的裁剪版:

| boundary v1 | 本契约 | 为什么 |
|---|---|---|
| `structured`(四 Tab) | **无此字段** | audit-ai 靠 `structured_for` 另跑一次检索装配 `structured` 视图;`policy-query` 这个 taskKind 没有这条路径,`answer` 里不会出现,也不会将来"悄悄补上" |
| `meta.{route_type, ai_label, review_required, export_enabled}` | **无此字段** | 这四个是 audit-ai `QueryResult` 的业务字段;`policy-query` 的输出契约里没有对应概念,不会出现在 `answer` 里 |
| `answer_blocks[]`(有序、带 `block_type`) | `conclusion`:单个字符串 | `policy-query` 的输出契约就是这么定义的(§2)—— 不是省略了 `answer_blocks`,是压根没有这个概念 |
| `completion.confidence`:数字(如 `0.8`) | `confidence`:枚举 `"high" \| "medium" \| "low"` | 类型冲突,`task-runtime` 不做强转,Java 侧也不应该把三档枚举硬转成数字 |
| `citations[].score`:从检索候选派生 | `basis[].score`:模型抄写 | 来历不同、可信程度不同,见 §4 |

⇒ Java 侧**不能**假设能从这份契约里拼出 boundary v1 形状的响应,也不能假设未来会补齐。如果下游确实需要
`structured` / `meta.*` / `answer_blocks[]` 这类东西,那是一次独立的产品决策,不是本契约的降级路径。

---

## 6. `output` 字段:保留,不建议解析

`output` 是本次 run 最后一条助手消息的原始文本,通常带 markdown 围栏(例如 ` ```json ... ``` `),**不保证是
合法 JSON,也不保证通过了 C6 的 schema 校验** —— `status !== "completed"` 的终态(尤其是 C6 判定不合规导致
的 `"error"`)下,`output` 里的文本就是被 C6 拒掉的那一份,原样保留下来只是为了诊断(见 §0)。

**不建议 Java 自己解析 `output`。** 需要结构化数据时用 `answer`(`status === "completed"` 时优先读它);
`output` 的用途是留痕与排障 —— 比如 `status === "error"` 时配合 `errorMessage` 定位 C6 具体因为哪条规则拒绝
了这次输出。
