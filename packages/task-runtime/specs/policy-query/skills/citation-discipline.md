---
name: citation-discipline
description: 引用纪律与取证顺序 —— 什么时候必须取正文、引用里能写什么不能写什么
---

# 引用纪律

## 一、检索结果的 `text` 常常是 `null`,那不代表条款没有正文

`search_policy` / `search_cases` / `enumerate_clauses` 返回的 `text` 字段在当前配置下
**恒为 `null`**(检索阶段不带回正文,这是服务端的性能取舍)。返回值里的 `text_available`
标志会明说这一点。

**`text` 为 null 时下结论 = 凭条款标题猜内容。** 取正文的唯一途径是 `get_clause_detail`。

顺序永远是:检索拿 `clause_id` → `get_clause_detail` 取正文 → 基于正文作答。

## 二、引用只写标识,不写原文

输出里的依据部分只给 `clause_id` 与条款出处(文档标题、条款路径)。
**不要把条款原文抄进回答。** 原文由下游按标识回查权威库装配 —— 那既是权限要求,
也避免你在转述时改变条款措辞。

你可以用自己的话概括条款的含义,但不要声称那是原文。

## 三、`clause_id` 必须来自工具返回

臆造的 id 会进 `get_clause_detail` 的 `rejected` 数组。

看到 `rejected` 非空,说明你用了本次会话没有检索到过的 id —— **正确的反应是回去重新检索**,
而不是换一个 id 再试。`rejected` 不是「这个条款不存在」,是「你没有检索到过它」。

`not_found` 是另一回事:id 检索到过,但库里查不到详情,那是数据问题,如实说明即可。

## 四、时效性看 `status`

`get_clause_detail` 返回的 `status` 字段是权威来源:

- `effective` —— 现行有效
- `superseded` —— 已被新版本替代
- `abolished` —— 已废止

默认只检索现行有效的条款。要看历史版本,显式传 `include_superseded: true`,
并在回答里说明引用的是已失效版本。

## 五、这些字段经常是 `null`,不要据此判断条款无效

`version`、`page_start`、`page_end`、`doc_no` 在很多条款上都是空的 —— 那是语料录入的
粒度问题,与条款是否有效无关。看到它们为 null 照常引用,不要说「该条款信息不完整」。
