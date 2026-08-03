import { validateOutputContract } from "./output-contract.ts";

export type FastPathVerdict = { accept: true } | { accept: false; reason: string };

interface FastAnswerShape {
	finish_reason?: unknown;
	confidence?: unknown;
	basis?: unknown;
}

/**
 * 规格 §3 的升级判据。**四条全过才收下**,任何一条不过都升级 ——
 * 方向是「宁可多升级,不可答差」。
 *
 * 判据 1 走 `validateOutputContract`(与 C6 判官**同一份**实现),但**不注册 C6 judge**:
 * `createOutputContractJudge` 的 `onExhausted` 是 "error",`maxRepairAttempts: 0` 会让第一次
 * 不通过就把 run 判成 error,而快路径要的是升级,不是失败。
 */
export function judgeFastPathOutput(text: string, schema: unknown, clauseIds: readonly string[]): FastPathVerdict {
	const checked = validateOutputContract(text, schema, clauseIds);
	if (!checked.ok) return { accept: false, reason: `输出契约不通过:${checked.detail}` };

	const json = checked.value as FastAnswerShape;
	if (json.finish_reason !== "stop") {
		return { accept: false, reason: `finish_reason 不是 "stop"(实际:${String(json.finish_reason)})` };
	}
	if (json.confidence !== "high" && json.confidence !== "medium") {
		return { accept: false, reason: `confidence 不在 {high, medium}(实际:${String(json.confidence)})` };
	}
	if (!Array.isArray(json.basis) || json.basis.length === 0) {
		return { accept: false, reason: "basis 为空" };
	}
	return { accept: true };
}
