import { Value } from "typebox/value";
import type { FinalJudge, JudgeContext, JudgeVerdict } from "./final-judge.ts";

/**
 * 从助手文本里挖出 JSON。允许三种形态:裸对象、```json 围栏、无标签围栏。
 * 挖不到返回 undefined —— 调用方据此判"未找到 JSON",不要和"JSON 不合 schema"混为一谈。
 */
export function extractJsonBlock(text: string): unknown {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(text);
	const candidates = fenced?.[1] === undefined ? [text] : [fenced[1], text];
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) continue;
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			// 试下一个候选
		}
	}
	return undefined;
}

interface ContractShape {
	finish_reason?: unknown;
	basis?: unknown;
	exhausted_scope?: unknown;
}

/** §4.2 的条件约束 + 反幻觉。返回错误说明,通过时返回 undefined。 */
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
	const invented = basis
		.map((item) =>
			typeof item === "object" && item !== null ? (item as { clause_id?: unknown }).clause_id : undefined,
		)
		.filter((id): id is string => typeof id === "string")
		.filter((id) => !retrieved.has(id));
	if (invented.length > 0) {
		return `basis 里的 clause_id 未出现在本次检索结果中:${invented.join("、")}`;
	}
	return undefined;
}

export function createOutputContractJudge(options: { schema: unknown; maxRepairAttempts: number }): FinalJudge {
	return {
		name: "output-contract",
		maxAttempts: options.maxRepairAttempts,
		// 输出不合契约是硬失败:Java 拿不到能解析的结果,不能假装成功。
		onExhausted: "error",
		judge: async (context: JudgeContext): Promise<JudgeVerdict> => {
			const json = extractJsonBlock(context.lastAssistantText);
			if (json === undefined) {
				return {
					ok: false,
					detail: "未找到 JSON 块",
					followUp: "输出不符合契约:未找到 JSON 块。请仅输出符合 schema 的 JSON,不要夹带其他文字。",
				};
			}

			// typebox 的 Value.Check 直接吃 draft-07 裸 schema(enum / additionalProperties /
			// type:["string","null"] 均正确),不必再引第二个校验库。错误对象的路径字段是
			// instancePath,不是 path。
			if (!Value.Check(options.schema as never, json)) {
				const first = [...Value.Errors(options.schema as never, json)][0];
				const where =
					first?.instancePath === "" || first?.instancePath === undefined ? "(root)" : first.instancePath;
				const detail = `${where} ${first?.message ?? "schema 校验失败"}`;
				return { ok: false, detail, followUp: `输出不符合契约:${detail}。请仅输出符合 schema 的 JSON。` };
			}

			const conditional = checkConditional(json as ContractShape, context.clauseIds);
			if (conditional !== undefined) {
				return {
					ok: false,
					detail: conditional,
					followUp: `输出不符合契约:${conditional}。clause_id 必须来自本次检索结果,不得臆造;补齐后重新输出 JSON。`,
				};
			}

			return { ok: true };
		},
	};
}
