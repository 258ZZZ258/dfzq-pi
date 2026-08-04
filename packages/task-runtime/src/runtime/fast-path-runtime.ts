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
	// 纵深防御,当前不可达:能走到这里意味着判据 1(`validateOutputContract`)已通过、且
	// `finish_reason === "stop"`;而 `output-contract.ts` 的 `checkConditional` 已经把
	// "finish_reason 为 stop 且 basis 为空" 判进判据 1 的失败分支(`basis` 非数组时被同一段
	// 三元表达式塌成 `[]`,同样命中该分支),所以这里的条件此刻恒为 false —— 实测把这个 if
	// 整块删掉,`fast-path-runtime.test.ts` 全部用例照样全绿。留着不删是防 `checkConditional`
	// 未来改动后这条判据悄悄失去着落;不是在断言它现在拦得住什么。
	if (!Array.isArray(json.basis) || json.basis.length === 0) {
		return { accept: false, reason: "basis 为空" };
	}
	return { accept: true };
}
