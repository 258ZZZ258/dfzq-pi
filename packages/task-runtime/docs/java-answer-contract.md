# task-runtime → Java 应答契约

适用范围:`POST /runs` / `GET /runs/:runId` 对 `taskKind: "policy-query"` 的返回体。这两个端点在 run 到达终态
前后回不同形状的响应体 —— 一共三种形态,见 §1。本文档主体(§2 起)讲的是其中**终态**那一种响应体:`RunResult`
(定义见 `packages/task-runtime/src/runtime/contract.ts`)。`RunResult` 的字段清单(§2)对任何 taskKind 都成立,
但 `answer` 的具体形状(§3)是 `policy-query` 这一个 spec 的输出契约
(`packages/task-runtime/specs/policy-query/output-contract.schema.json`)决定的 —— 换一个 taskKind,`answer`
的形状会不一样。

---

## 0. 先看这条:`answer` 只在 `status === "completed"` 时出现

**消费 `answer` 之前必须先判断 `status`,而且要先排除 `"queued"` / `"running"` 这两个非终态值。** 这两个值只
出现在 §1 说的精简响应体 `{runId, status}` 里,那种响应体压根没有 `answer` 字段可言,但**这不是失败** ——
run 还在跑,不能套用下面"非 `completed` ⇒ 转人工"的判断。排除 `"queued"` / `"running"` 之后,只要
`status !== "completed"`(即 `"aborted"` / `"limit_exceeded"` / `"error"`),响应体里**不会有 `answer`
字段** —— 不管 `output` 里能不能抠出语法合法的 JSON。

这不是保守起见的额外判断,而是一条真实踩过的坑:C6(输出契约判官,`onExhausted: "error"`)判定输出不合规时,
run 的终态是 `"error"`,但产生这份输出的助手文本仍然会**原样**写进 `output`。早先的实现只看 `output` 里能不能
抠出 JSON、不看 `status`,于是被 C6 拒掉的 JSON —— 例如 `basis[]` 里引用了本次检索未命中过的 `clause_id`,
正是反幻觉兜底(§3 的"反幻觉"一条)要拦截的那一类 —— 会原样进 `answer`。这条机制记录在
`packages/task-runtime/src/runtime/contract.ts:51-58` 的复审注释里。现在 `toWireResult`
(`packages/task-runtime/src/server/routes.ts`)的第一行判断就是这道闸门:

```ts
export function toWireResult(result: RunResult): RunResult {
	if (result.status !== "completed") return result;
	...
}
```

⇒ **Java 侧的消费顺序必须是:先读 `status`——`"queued"` / `"running"` 意味着 run 还没跑完(§1),继续等待
或轮询;`status === "completed"` 才去读 `answer`;真正落到 `"aborted"` / `"limit_exceeded"` / `"error"`
时按 §4 降级。**

---

## 1. 响应的三种形态

`POST /runs` 与 `GET /runs/:runId` 不总是回同一种形状的响应体。分不清这三种形态,轮询逻辑会把"还在跑"误判成
"失败"。

| 形态 | HTTP 状态码 | 出现在哪个端点 | 响应体形状 | 何时出现 |
|---|---|---|---|---|
| 终态 200 | `200` | `POST /runs`、`GET /runs/:runId` 都有 | 完整 `RunResult`(§2),已经过 `toWireResult` | run 已经到达终态:`completed` / `aborted` / `limit_exceeded` / `error` |
| 非终态 200 | `200` | 只有 `GET /runs/:runId` | `{ runId, status }`,`status ∈ {"queued", "running"}` | 查询到的 run 还没到终态 |
| 202 | `202` | 只有 `POST /runs`(等待窗口 `waitMs` 内 run 没跑完) | `{ runId, status }`,`status ∈ {"queued", "running"}` | 提交的 run 在等待窗口内没有到达终态;run 本身继续在后台推进,不受影响 |

三点需要注意(已对照 `packages/task-runtime/src/server/app.ts` 与
`packages/task-runtime/src/server/middleware/validate.ts` 核实):

- **`GET /runs/:runId` 永远回 200,从不回 202。** 非终态时它回的是 200 + `{runId, status}`
  (`app.ts`:`if (!isTerminal(row.status)) return c.json({ runId: row.runId, status: row.status }, 200);`)——
  HTTP 状态码本身不能用来判断 run 是否结束,必须读 body 里的 `status`。
- **`POST /runs` 的非终态响应恒为 202,不会是 200。** `waitMs` 的缺省值与服务端上限都是 30 秒
  (`WAIT_MS_DEFAULT` / `WAIT_MS_MAX`,均定义在 `validate.ts`),而 `policy-query` 这个 taskKind 的
  `runTimeoutMs` 是 900 秒(`specs/policy-query.json`)——**长 run 必然先拿到一个 202**,之后要靠轮询
  `GET /runs/:runId` 拿终态,这是 `policy-query` 的主路径,不是边缘情况。
- **非终态响应体只有 `runId`、`status` 两个键。** `usage` / `turns` / `durationMs` / `answer` 等字段在这两种
  形态里都不存在;§2 表格里标"恒有"的字段,专指终态 200 响应体,逐行标注见该表。

⇒ Java 侧的轮询逻辑应该是:先看 `status` 是否为 `"completed"` / `"aborted"` / `"limit_exceeded"` /
`"error"` 之一(终态);是 `"queued"` / `"running"` 就继续等待/轮询,**不要**当成失败或转人工。

---

## 2. `RunResult` 完整字段

**本节描述的是终态 200 响应体**(§1 的第一种形态)。非终态 200 与 202 的响应体只有 `runId`、`status` 两个键
(见 §1);本表除这两行外的其余字段,在那两种形态里都不存在。

| 字段 | 类型 | 何时存在 | 说明 |
|---|---|---|---|
| `runId` | `string` | 三种形态都有(§1) | 本次 run 的唯一 ID |
| `specId` | `string` | 仅终态 200 有 | 产生本次 run 的 spec id;`taskKind` 与 spec id 一一对应,Java 传 `taskKind: "policy-query"` 时这里回的也是 `"policy-query"` |
| `status` | 终态 200:`"completed" \| "aborted" \| "limit_exceeded" \| "error"`;非终态 200 / 202:`"queued" \| "running"` | 三种形态都有 | 终态含义见 §0;非终态含义见 §1 |
| `output` | `string \| undefined` | 仅终态 200,且 run 产生过助手文本时有 | 原始助手文本,带 markdown 围栏,**未必是合法 JSON、未必通过 C6**。诊断/审计用,见 §7 |
| `errorMessage` | `string \| undefined` | 仅终态 200,常见于 `status === "error"` | 人类可读的失败原因(判官拒绝详情、异常信息等) |
| `stopReason` | `string \| undefined` | 仅终态 200,通常有 | 模型侧上报的停止原因 |
| `limit` | `"maxTurns" \| "runTimeout" \| "maxTotalTokens" \| "maxCostUsd" \| undefined` | 仅终态 200,`status === "limit_exceeded"` 时有意义 | 命中的限额种类 |
| `usage` | `{ input, output, cacheRead, cacheWrite, total, cost }`(均为 `number`) | 仅终态 200 恒有;非终态 200 / 202 不存在此字段 | token 用量与成本;`cost` 与 spec 的 `limits.maxCostUsd` 是同一口径(同一个数字直接比较) |
| `turns` | `number` | 仅终态 200 恒有;非终态 200 / 202 不存在此字段 | 本次 run 走过的轮次 |
| `durationMs` | `number` | 仅终态 200 恒有;非终态 200 / 202 不存在此字段 | 耗时(毫秒) |
| `judgeAttempts` | `Record<string, number>` | 仅终态 200,键恒在,但**经 HTTP 拿到的值通常是 `{}`** | 见下方单独说明,不建议依赖 |
| `answer` | `unknown` | 仅终态 200,且 `status === "completed"` 且能从 `output` 提取出可解析 JSON 时有 | 本文档主角,见 §0、§3、§4 |

**`judgeAttempts` 的 HTTP 侧陷阱**:这个字段设计上只服务进程内验收,不落库。终态结果有四个 HTTP 出口,其中
三个(`POST /runs` 的幂等分支、等待窗口超时后查库、`GET /runs/:runId`)都经 `recordToRunResult` 从落库行重建
`RunResult`,`judgeAttempts` 在这三条路径上恒为 `{}`;只有第四条 —— `POST /runs` 在 `waitMs` 窗口内同步拿到
完成结果的那条分支 —— 直接返回内存里算出来的 `RunResult`,这里才有真值。**Java 不应依赖 `judgeAttempts` 做
业务判断**,大多数请求路径上它都是空的。

---

## 3. `answer` 的形状(policy-query 的输出契约)

`answer` 的值来自 `output` 的 JSON 块,且已经过 C6(输出契约判官)按
`specs/policy-query/output-contract.schema.json` 校验通过(§4 说明"通过"具体保证了什么、没保证什么)。本文档
描述的 `answer` 形状,是 `policy-query` 这一个 spec 的输出契约决定的:

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

`source_details` 是一个**可选的服务端附加字段**，不属于模型输出契约：当本次运行已经通过
`get_clause_detail` 取回权威正文时，终态 HTTP 响应会在 `answer` 内附上该数组。每项至少包含
`clause_id` 与非空 `text`，并可能含 `doc_title`、`clause_path`、`source_code`、`status` 等来自
权威库的元数据。Java 应按 `clause_id` 将它与 `basis` 对应，直接用于“查看原文”；它缺省时表示本次
运行没有可复用的正文，不能把缺省误判为条款不存在，也不能用模型生成的 `conclusion` 充当原文。

顶层必填(schema `required`):`conclusion` / `basis` / `confidence` / `finish_reason`。`reasoning` /
`exhausted_scope` / `gaps` 是可选键。

`basis[]` 每个元素**只强制 `clause_id` 必填**;其余七键在 schema 层面允许缺省或为 `null`
(`score`/`source_code`/`source_doc_id`/`clause_path`/`doc_title` 的类型是 `["number"|"string", "null"]`,
`status`/`corpus_type` 是没有 `null` 分支的枚举 —— 一旦给出就必须是列举的那几个值之一,但同样不是必填)。
`basis[]` 的元素**只能有这八个键**(schema 的 `additionalProperties: false`),不会多出别的字段 —— 比如条款
原文;契约正文(`output-format.md`)明确禁止把原文塞进 `basis`,原文由下游按 `source_code` 回查权威库装配。

`status === "completed"` 时,`answer` 还隐含三条业务规则(由 C6 强制,不在 JSON Schema 的 `required` 里,但
不满足就到不了 `completed`):

- `finish_reason === "stop"` ⇒ `basis` 非空;
- `finish_reason === "refused"` ⇒ `exhausted_scope` 非空;
- **反幻觉**:`basis[].clause_id` 必须是本次 run 真实检索到过的 clause_id 之一 —— 引用了本次检索结果之外的
  clause_id,C6 判失败,run 到不了 `completed`,`answer` 也就不会出现(见 §0)。

⇒ 当 `answer` 出现时,`basis[].clause_id` 的可信度是有保证的(通过了反幻觉校验);但 `basis[].score`
**不在这份保证范围内** —— 见 §5。

---

## 4. `answer` 缺省的三种情形与降级

`answer` 由 `toWireResult`(`packages/task-runtime/src/server/routes.ts`)在终态 `RunResult` 上现算,不落库、
不重新跑模型。`toWireResult` 只看两件事 —— `status` 与 `output` 里能不能提取出合法 JSON
(`extractJsonBlock`),**从不查 spec 是否声明了 `outputContract`**。共有三种情形会让 `answer` 缺省:

| # | 情形 | 触发条件 | 对 `policy-query` 当前是否会出现 |
|---|---|---|---|
| 1 | **`status !== "completed"`** | `status` 是 `"aborted"` / `"limit_exceeded"` / `"error"`(含 C6 判定不合规、reprompt 次数耗尽那一类) | 会 —— 这是最外层闸门,见 §0 |
| 2 | `output` 本身是 `undefined`,或 `output` 有内容但挖不出花括号包裹的候选(`extractJsonBlock` 返回 `absent`) | 助手最终没产出文本,或产出的是纯散文,没有 `{…}` | 理论上不会:见下方说明 |
| 3 | 花括号配对但 `JSON.parse` 失败(`extractJsonBlock` 返回 `unparsable`) | 挖出的候选语法不合法 | 理论上不会:见下方说明 |

**#2/#3 对 `policy-query` 只是防御性表格项,不是已观察到的行为**:只要这个 taskKind 继续声明
`outputContract`(现状如此),`status === "completed"` 就意味着 C6 已经用同一个提取函数(`extractJsonBlock`)
验证过 `output` 里有语法合法、schema 合规的 JSON;`toWireResult` 之后用同一段 `output` 文本重新提取一次,
按设计应当得到同样的结果。写出 #2/#3 是因为 `toWireResult` 的代码路径本身允许这两种结果(它不知道、也不假设
调用方一定声明了 `outputContract`),不是因为已经在 `policy-query` 上观察到它们发生过。

**`outputContract` 不是第四种独立缺省成因,而是 #2/#3 会不会真的发生的前提条件**:`toWireResult` 本身从不查
spec 是否声明了 `outputContract`。真正起作用的是 C6 判官挂不挂载(`session-runtime.ts`):spec 声明了
`outputContract`,C6 才会挂载,`status === "completed"` 就连带保证了 `output` 已经过 schema 校验,#2/#3 因此
在实践里不会发生;spec 不声明 `outputContract`,C6 根本不挂载,`status` 可以是 `"completed"` 而 `output`
从未经过任何 schema 校验 —— 这时 #2/#3 才从"理论上不会"的防御性表格项,变成可能真的发生。`policy-query`
的 spec 文件(`specs/policy-query.json`)声明了 `outputContract`,不受这条影响;仓库里目前只有
`blackbox-eval` 这个 taskKind 没声明 —— `loadSpecRouter` 对 `specsDir` 下的 spec 一视同仁地加载,没有按
taskKind 的白名单/黑名单,`blackbox-eval` 是否会被路由完全取决于运维配置的 `specsDir` 包含哪些文件,这不是
代码层面的强制隔离。

**Java 侧降级建议**:

- 先排除 `status` 是 `"queued"` / `"running"` 的情形(§1)—— 那是 run 还没跑完,不是失败,不要转人工。
- 排除之后,`status !== "completed"`(即 `"aborted"` / `"limit_exceeded"` / `"error"`):不要读 `answer`
  (它不存在)。按业务判失败 / 转人工;需要诊断可以读 `output`,但 `output` 未必合规,见 §7。
- `status === "completed"` 但响应体没有 `answer` 键(#2/#3 任一种):同样不要假设 `output` 里有可解析的
  结构;按业务判"取不到结构化应答",不建议自行重新解析 `output`(理由见 §7)。

---

## 5. `basis[].score`:诚实登记

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

## 6. 与 boundary v1 的差异 —— 这不是 boundary v1,不要按那套假设消费

本契约与 audit-ai 现有的 boundary v1 应答形状**不兼容,也不是它的子集或近似**。下表逐项列出差异,"本契约"一栏
是本文档实际描述的形状(§3),不是 boundary v1 的裁剪版:

| boundary v1 | 本契约 | 为什么 |
|---|---|---|
| `structured`(四 Tab) | **无此字段** | audit-ai 靠 `structured_for` 另跑一次检索装配 `structured` 视图;`policy-query` 这个 taskKind 没有这条路径,`answer` 里不会出现,也不会将来"悄悄补上" |
| `meta.{route_type, ai_label, review_required, export_enabled}` | **无此字段** | 这四个是 audit-ai `QueryResult` 的业务字段;`policy-query` 的输出契约里没有对应概念,不会出现在 `answer` 里 |
| `answer_blocks[]`(有序、带 `block_type`) | `conclusion`:单个字符串 | `policy-query` 的输出契约就是这么定义的(§3)—— 不是省略了 `answer_blocks`,是压根没有这个概念 |
| `completion.confidence`:数字(如 `0.8`) | `confidence`:枚举 `"high" \| "medium" \| "low"` | 类型冲突,`task-runtime` 不做强转,Java 侧也不应该把三档枚举硬转成数字 |
| `citations[].score`:从检索候选派生 | `basis[].score`:模型抄写 | 来历不同、可信程度不同,见 §5 |

⇒ Java 侧**不能**假设能从这份契约里拼出 boundary v1 形状的响应,也不能假设未来会补齐。如果下游确实需要
`structured` / `meta.*` / `answer_blocks[]` 这类东西,那是一次独立的产品决策,不是本契约的降级路径。

---

## 7. `output` 字段:保留,不建议解析

`output` 是本次 run 最后一条助手消息的原始文本,通常带 markdown 围栏(例如 ` ```json ... ``` `),**不保证是
合法 JSON,也不保证通过了 C6 的 schema 校验** —— `status !== "completed"` 的终态(尤其是 C6 判定不合规导致
的 `"error"`)下,`output` 里的文本就是被 C6 拒掉的那一份,原样保留下来只是为了诊断(见 §0)。

**不建议 Java 自己解析 `output`。** 需要结构化数据时用 `answer`(`status === "completed"` 时优先读它);
`output` 的用途是留痕与排障 —— 比如 `status === "error"` 时配合 `errorMessage` 定位 C6 具体因为哪条规则拒绝
了这次输出。

---

## 8. 快路径与升级(两阶段)

`policy-query` 的 spec 可以声明 `fastPath`(`specs/policy-query.json` 的 `fastPath` 字段)。声明且启用后,
这个 taskKind 的 run 会先走一条确定性快路径(模型调用固定 2 次,模型看不到工具,检索由代码代为发起);快
路径产出不达标时,自动升级到既有的 agent 自主编排路径重新跑一遍。"不达标"覆盖:契约校验不过(含反幻觉
校验 —— `basis[].clause_id` 引用了本次检索未命中过的条款)、`finish_reason` 不是 `"stop"`(即
`"refused"`)、`confidence` 是 `"low"`、检索没拿到可用结果,或阶段 1 本身超时/撞限额/抛错。
**正常升级过程对 Java 透明** —— 从 HTTP 契约的角度看不出区别,一个 `runId`、一个终态,响应体形状与 §2
完全一致;唯一不同的是下表几个字段的取值口径。**取消(`POST /runs/:runId/cancel`)是这条透明性的例外**,
见下面单独一段。

| 字段 | 未升级(快路径直接收下) | 升级过(快路径 → agent 重跑) |
|---|---|---|
| `runId` | 一个 | 同一个,两阶段共用 |
| `status` / `output` / `answer` | 快路径这一阶段产出的 | agent 重跑那一阶段(阶段 2)产出的。**快路径阶段的输出到此为止,不会出现在 `output` 或 `answer` 里** |
| `turns` | 快路径的轮次 | **两阶段之和** |
| `usage` | 快路径这一次的用量 | **两阶段之和**(`input`/`output`/`cacheRead`/`cacheWrite`/`total`/`cost` 逐字段相加) |

⇒ **不要用 `turns` 反推模型调用了几次** —— 升级过的 run 里它是两段相加,不是单一阶段的轮次。`turns`
与 `usage` 在终态 200 响应体的四条落地路径上(§2 `judgeAttempts` 一节列的同一组四条:`POST /runs`
的幂等分支、等待窗口超时后查库、`waitMs` 内同步完成、`GET /runs/:runId`)取值一致 —— 它们随
`RunResult` 一起落库(`usage_json`/`turns` 字段),四条出口读到的是同一份值。

**`durationMs` 不适用上面这条一致性,单独说明**:`RunResult.durationMs` 本身**不落库**。四条出口里
只有"`waitMs` 内同步完成"这一条直接返回内存里现算的 `RunResult`,这时 `durationMs` 才是升级过的 run
的两阶段之和;其余三条出口都是从落库行重建,读到的 `durationMs` 是 `finished_at - started_at` 的挂钟
差值 —— **不是两阶段之和,数值还会更大**(升级发生时,装配阶段 2、含起第二个 MCP 子进程的耗时,落在
这段挂钟差值里,却不计入两阶段各自内部统计的"之和")。而 §1 已经指出:`policy-query` 的
`runTimeoutMs` 是 900 秒,远超 `waitMs` 的上限(30 秒),长 run 必然先拿到 202、之后靠轮询
`GET /runs/:runId` 拿终态 —— 也就是说 `policy-query` 的**主路径**,拿到的正是这个挂钟差值,不是
"两阶段之和"。**Java 侧不要假设 `durationMs` 精确等于两次模型调用各自耗时相加**,它的准确语义取决于
这次终态是从哪一条出口拿到的(见 §2)。

**取消:`POST /runs/:runId/cancel`,本文档第一次带到的第三个端点。** 文档开头声明的适用范围只列了
`POST /runs` 与 `GET /runs/:runId`,§1 的三态表也不包含这个端点——它单独在这里说明,不套用 §1 那张表。

这个端点本身有三种响应(`server/app.ts`):`202`(取消意图已受理;**不是终态**,不代表 run 已经停,真正
的终态仍然要靠轮询 `GET /runs/:runId` 拿,与 §1 末尾"轮询逻辑"那条一般规则一致)、`409`
(`errorBody("already_terminal", ...)`,run 已经到达终态,取消没有意义)、`404`
(`errorBody("not_found", ...)`,通常是 runId 不存在)。下面只讨论 `202` 之后 run 最终会落到什么终态。

若这次 cancel 落在快路径阶段,**且快路径最终没有独立产出一份通过校验的答案**(即 `verdict.accept` 仍是
`false`——这是最常见的情形,因为 `session.abort()` 打断的正是模型调用或检索本身,含快路径已经判定要
升级、但阶段 2 还没真正开始跑这段窗口),run 不会再去起 agent 路径重跑一遍 —— 终态 `status` 直接是
`"aborted"`(`server/run-manager.ts` 的 `finishAsAborted` 与 `runtime/session-runtime.ts` 的
`classify()` 用的是同一个值代表用户取消;不会是 `"limit_exceeded"` —— 那个值专指限额/超时,两者不
混用);这种情形下 `turns`/`usage` 只反映快路径这一阶段已经花掉的部分,不会有阶段 2 的贡献(阶段 2
从未真正跑起来)。

**但这不是无条件的。** 如果 cancel 恰好在快路径已经吐出一份完整、通过校验的答案(`verdict.accept` 为
`true`)之后才生效——两者可能在极窄的时间窗口内竞速,`session.abort()` 打断时模型②有可能已经把完整
JSON 吐完了——run 仍然按"收下即止"的既有规则以 `status:"completed"` 收尾、`answer` 照常出现在响应体
里,**不会**因为外部另有一次 `abort()` 调用就被推翻成 `"aborted"`。

若 cancel 落在阶段 2 已经在跑之后(即已经升级、agent 路径正在执行),`turns`/`usage` 仍是上表说的两阶段
之和 —— 阶段 2 只是被提前打断,不是没跑过;这种情形的终态 `status` 同样是 `"aborted"`,来自阶段 2 自身
的落地逻辑(与不带快路径时 cancel 一个正在跑的 run 是同一条路径,不是本节新增的行为)。

现状:出厂 spec(`specs/policy-query.json`)的 `fastPath.enabled` 是 `false`,本节描述的两阶段行为目前不会
发生。`enabled` 本身也不是响应体的字段、不出现在 Java 收到的任何响应里 —— Java 不需要感知这个开关的状
态,也不需要区分"这次 run 走没走快路径";§2 的字段清单与本节的取值口径对两种情形都成立。
