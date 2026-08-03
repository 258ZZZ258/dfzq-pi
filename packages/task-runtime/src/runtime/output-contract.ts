import { Value } from "typebox/value";
import type { FinalJudge, JudgeContext, JudgeVerdict } from "./final-judge.ts";

export type JsonBlockResult =
	| { kind: "ok"; value: unknown }
	| { kind: "unparsable"; error: string; snippet: string }
	| { kind: "absent" };

const SNIPPET_RADIUS = 80;

/** 从 V8 的 "…at position 2532 (line 80 column 10)" 里取位置;取不到返回 0。 */
function parseErrorPosition(message: string): number {
	const m = /at position (\d+)/.exec(message);
	return m ? Number(m[1]) : 0;
}

/**
 * 从助手文本里挖出 JSON。允许三种形态:裸对象、```json 围栏、无标签围栏。
 *
 * **三态而非二态**:`absent`(压根没有花括号,模型输出的是散文)与 `unparsable`
 * (有花括号但 JSON 坏了)必须分开 —— 前者没有解析错误可报,后者有,而 C6 的 followUp
 * 要靠后者告诉模型错在第几个字符。合并成一个 undefined 就是把这条信息扔掉,那正是
 * 第 7 次真 run 只能拿到「未找到 JSON 块」的原因。
 *
 * candidates 的顺序是 `[围栏内容, 原文本]`——**实测过**这不是两次对称的尝试:
 * - 围栏内容本身不含花括号(比如模型贴的是一段非 JSON 的代码块)时,第一个候选在
 *   `start < 0` 处 `continue`,回退到原文本、从紧跟着的裸 JSON 里截出结果 —— 这条回退
 *   路径**实测真的会走通**(见 `test/output-contract.test.ts` 的
 *   "reads a bare JSON object that follows an unlabelled non-JSON fence" 用例)。
 * - 围栏内容含花括号但解析失败时,原文本的 `indexOf("{")…lastIndexOf("}")` 跨度必然
 *   **包住**围栏里那段坏内容(原文本本来就包含整个围栏),回退候选截出来的还是同一段坏
 *   JSON。**实测这种情况下 `catch` 分支恢复不了**——保留第二个候选只是为了上面那种
 *   "围栏非 JSON + 裸 JSON 兜底" 的场景,不是为了"从损坏的围栏里抢救"。
 *   ⇒ 因此 `unparsable` 报的是**最后一个候选**的错误。
 */
export function extractJsonBlock(text: string): JsonBlockResult {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(text);
	const candidates = fenced?.[1] === undefined ? [text] : [fenced[1], text];
	let lastFailure: { error: string; snippet: string } | undefined;
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) continue;
		const slice = trimmed.slice(start, end + 1);
		try {
			return { kind: "ok", value: JSON.parse(slice) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const at = parseErrorPosition(message);
			lastFailure = {
				error: message,
				snippet: slice.slice(Math.max(0, at - SNIPPET_RADIUS), at + SNIPPET_RADIUS),
			};
		}
	}
	return lastFailure ? { kind: "unparsable", ...lastFailure } : { kind: "absent" };
}

interface ContractShape {
	finish_reason?: unknown;
	basis?: unknown;
	exhausted_scope?: unknown;
}

interface KeyDiff {
	missing: string[];
	extra: string[];
}

/**
 * 沿 instancePath 同步走 schema 与 value,算该层对象的键差集。
 *
 * **这不是 schema 解析器,只认 `properties` 与 `items` 两种走法。** 遇到
 * `$ref` / `allOf` / `oneOf` / `anyOf` 立刻放弃(返回 undefined),followUp 退回只带
 * instancePath。宁可少给一份差集,也不给一份错的 —— 错的差集会让模型去改一个没错的字段。
 *
 * `extra` **只在 `additionalProperties === false` 时才报**:schema 允许额外属性时,
 * 多出来的键根本不是错误,报出来是诬告。
 */
function keyDiffAt(schema: unknown, value: unknown, instancePath: string): KeyDiff | undefined {
	const segments = instancePath.split("/").filter((s) => s.length > 0);
	let node: Record<string, unknown> | undefined = isRecord(schema) ? schema : undefined;
	let current: unknown = value;
	for (const segment of segments) {
		if (node === undefined) return undefined;
		if (node.$ref !== undefined || node.allOf !== undefined || node.oneOf !== undefined || node.anyOf !== undefined) {
			return undefined;
		}
		if (/^\d+$/.test(segment) && isRecord(node.items)) {
			node = node.items;
			current = Array.isArray(current) ? current[Number(segment)] : undefined;
			continue;
		}
		const properties = isRecord(node.properties) ? node.properties : undefined;
		const next = properties?.[segment];
		if (!isRecord(next)) return undefined;
		node = next;
		current = isRecord(current) ? current[segment] : undefined;
	}
	if (node === undefined || !isRecord(current)) return undefined;
	const properties = isRecord(node.properties) ? node.properties : undefined;
	if (properties === undefined) return undefined;
	const required = Array.isArray(node.required) ? node.required.filter((k): k is string => typeof k === "string") : [];
	const missing = required.filter((key) => !(key in current));
	const extra = node.additionalProperties === false ? Object.keys(current).filter((key) => !(key in properties)) : [];
	return missing.length === 0 && extra.length === 0 ? undefined : { missing, extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeKeyDiff(diff: KeyDiff): string {
	const parts: string[] = [];
	if (diff.missing.length > 0) parts.push(`缺少 ${diff.missing.join("、")}`);
	if (diff.extra.length > 0) parts.push(`多出 ${diff.extra.join("、")}`);
	return parts.join(";");
}

/**
 * §4.2 的条件约束 + 反幻觉。返回错误说明,通过时返回 undefined。
 *
 * **⚠ 反幻觉这一段的有效性寄生在 schema 上,这里不强制、也强制不了(2026-07-31 全分支
 * 审查 C-3)**:下面只对"能从 basis 元素里读出字符串 `clause_id`"的项判臆造。**元素不带
 * 这个键时 `invented` 为空,直接放行** —— 审查用一份不要求 basis 元素含 `clause_id` 的
 * schema 实测:`basis` 非空 + `clauseIds` 全空,判官照样返回 `{"ok":true}`。
 *
 * ⇒ **C8 的输出契约 schema 必须把 `clause_id` 声明为每个 basis 元素的 `required` 字段。**
 * 少写这一个 `required`,风险 10(pi 事件 schema 越界)的整个兜底就**静默消失** —— 而
 * 风险 10 在设计文档 §9 里至今开着,它唯一的兜底就是这里。写 schema 的人和读这段代码的
 * 人通常不是同一个,所以这条约束同时写在交接文档 §3.1 里。
 *
 * 这里不加"schema 未要求 clause_id 就报错"的校验:判官拿到的 schema 是任务级配置,在这一
 * 层反过来校验配置的形状是越权(而且 draft-07 里 `required` 可以藏在 `$ref` / `allOf` /
 * `oneOf` 后面,静态查全等于自己写半个 schema 解析器)。**这是刻意选择的"约束靠文档 +
 * 验收兜底",不是遗漏** —— 规格 §8 的验收用例应当包含"basis 带未检索到的 clause_id ⇒ 判
 * 失败"这一条,那才是这条约束的可执行凭证。
 */

/**
 * 从 basis[] 数组的元素里取字符串 clause_id;元素不是对象、没有这个键、或值不是字符串,
 * 都直接跳过(不计入返回值,也不报错)。
 *
 * `checkConditional` 的反幻觉判据与 `sufficiency-gate.ts` 的 `extractBasisClauseIds`
 * 共用这一份 —— 两处这条 `.map`/`.filter` 链此前逐字重复(2026-07-31 全分支审查
 * Minor,见 task-3 交接)。basis 是否为空、整段 JSON 能否解析,分别由各自调用方在
 * 调用前后处理,这个函数只认"给定一个数组,从里面挑得出字符串 clause_id 的元素"。
 */
export function extractClauseIds(basis: readonly unknown[]): string[] {
	return basis
		.map((item) =>
			typeof item === "object" && item !== null ? (item as { clause_id?: unknown }).clause_id : undefined,
		)
		.filter((id): id is string => typeof id === "string");
}

function checkConditional(json: ContractShape, clauseIds: readonly string[]): string | undefined {
	const basis = Array.isArray(json.basis) ? json.basis : [];
	if (json.finish_reason === "stop" && basis.length === 0) {
		return 'finish_reason 为 "stop" 时 basis 不能为空';
	}
	if (json.finish_reason === "refused") {
		const scope = Array.isArray(json.exhausted_scope) ? json.exhausted_scope : [];
		if (scope.length === 0) return 'finish_reason 为 "refused" 时 exhausted_scope 不能为空';
	}
	// 反幻觉:引用的条款必须是本 run 真检索到过的。
	const retrieved = new Set(clauseIds);
	const invented = extractClauseIds(basis).filter((id) => !retrieved.has(id));
	if (invented.length > 0) {
		const detail = `basis 里的 clause_id 未出现在本次检索结果中:${invented.join("、")}`;
		// retrieved 全空是这个兜底最容易被误读的情形:文案读起来像"模型编造了引用",但真实
		// 病因至少有三种,不止风险 10 那一类耦合:
		//   1. 上游改了事件字段名,导致 collectClauseIds 静默采空(风险 10);
		//   2. 本 run 的全部工具调用都失败了(session-runtime.ts 现在会过滤
		//      tool_execution_end.isError:true 的结果,Task 9 的 C3 语义决策)——查了但一次都
		//      没查到,retrieved 全空是如实反映,不是采集出了 bug;
		//   3. 本 run 压根没调用过任何工具。
		// 追一句诊断,把人指向"去查这三种可能",而不是先入为主地怪模型编造引用。
		return retrieved.size === 0 ? `${detail}(本次检索结果为空)` : detail;
	}
	return undefined;
}

export type ContractCheck = { ok: true; value: unknown } | { ok: false; detail: string; followUp: string };

/**
 * 输出契约校验的**唯一实现**。C6 判官(`createOutputContractJudge`)与快路径
 * (`fast-path-runtime.ts` 的升级判据)都调它 —— 两处各写一套必然漂移,而这一份正是
 * 反幻觉兜底(风险 10)的唯一落点。
 */
export function validateOutputContract(text: string, schema: unknown, clauseIds: readonly string[]): ContractCheck {
	const extracted = extractJsonBlock(text);
	if (extracted.kind === "absent") {
		return {
			ok: false,
			detail: "未找到 JSON 块",
			followUp: "输出不符合契约:未找到 JSON 块。请仅输出符合 schema 的 JSON,不要夹带其他文字。",
		};
	}
	if (extracted.kind === "unparsable") {
		const detail = `JSON 解析失败:${extracted.error}`;
		return {
			ok: false,
			detail,
			followUp:
				`输出不符合契约:${detail}\n出错位置附近的原文:\n${extracted.snippet}\n` +
				`请修正这处语法错误后重新输出完整 JSON。`,
		};
	}
	const json = extracted.value;

	// typebox 的 Value.Check 直接吃 draft-07 裸 schema(enum / additionalProperties /
	// type:["string","null"] 均正确),不必再引第二个校验库。错误对象的路径字段是
	// instancePath,不是 path。
	if (!Value.Check(schema as never, json)) {
		const first = [...Value.Errors(schema as never, json)][0];
		const instancePath = first?.instancePath ?? "";
		const where = instancePath === "" ? "(root)" : instancePath;
		const detail = `${where} ${first?.message ?? "schema 校验失败"}`;
		// 差集按**第一条错误所指的那一层**算,不是恒取顶层:第 5 次真 run 的错误在
		// /basis/0,恒取顶层会给出一份与病因无关的差集,把模型引向没错的字段。
		const diff = keyDiffAt(schema, json, instancePath);
		const diffText = diff ? `。该层键差异:${describeKeyDiff(diff)}` : "";
		return {
			ok: false,
			detail,
			followUp: `输出不符合契约:${detail}${diffText}。请仅输出符合 schema 的 JSON。`,
		};
	}

	const conditional = checkConditional(json as ContractShape, clauseIds);
	if (conditional !== undefined) {
		return {
			ok: false,
			detail: conditional,
			followUp: `输出不符合契约:${conditional}。clause_id 必须来自本次检索结果,不得臆造;补齐后重新输出 JSON。`,
		};
	}

	return { ok: true, value: json };
}

export function createOutputContractJudge(options: { schema: unknown; maxRepairAttempts: number }): FinalJudge {
	return {
		name: "output-contract",
		maxAttempts: options.maxRepairAttempts,
		// 输出不合契约是硬失败:Java 拿不到能解析的结果,不能假装成功。
		onExhausted: "error",
		judge: async (context: JudgeContext): Promise<JudgeVerdict> => {
			const checked = validateOutputContract(context.lastAssistantText, options.schema, context.clauseIds);
			return checked.ok ? { ok: true } : { ok: false, detail: checked.detail, followUp: checked.followUp };
		},
	};
}
