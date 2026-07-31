export interface JudgeContext {
	lastAssistantText: string;
	/** 本 run 全部工具结果里出现过的 clause_id。C3 与 C6 共用同一份。 */
	clauseIds: readonly string[];
}

export type JudgeVerdict = { ok: true } | { ok: false; followUp: string; detail?: string };

export interface FinalJudge {
	name: string;
	/** 允许派发的 followUp 次数上限。 */
	maxAttempts: number;
	/** 次数用尽后仍不通过时怎么办。 */
	onExhausted: "pass" | "error";
	judge: (c: JudgeContext) => Promise<JudgeVerdict>;
}

export interface RejudgeDeps {
	judges: readonly FinalJudge[];
	getLastAssistantText: () => string;
	getClauseIds: () => readonly string[];
	reprompt: (text: string) => Promise<void>;
	/** 限额已触发 / 已 abort 时为 true —— 此时不得再发 prompt。 */
	shouldStop: () => boolean;
}

export interface RejudgeOutcome {
	attempts: Record<string, number>;
	/** 非空表示某个 onExhausted:"error" 的判官用尽了次数且仍不通过。 */
	errorMessage?: string;
}

/**
 * 终局重判。住在 SessionRuntime.run() 里,在 session.prompt() 返回之后、归一化
 * RunResult 之前跑。
 *
 * 不做成 hook 插件:pi 的循环在"无更多工具调用且无排队消息"时停,而 prompt() 返回
 * 恰好就是那一刻 —— 与规格 §3.1 里 `isFinalTurn(e)` 想表达的是同一个时点。做在这一层
 * 不依赖任何 hook 语义,C3(证据充分性)与 C6(输出契约)因此能共用同一台驱动器。
 *
 * 终止性:每轮循环要么派发一次 reprompt(总次数被 Σ maxAttempts 界住),要么直接返回。
 */
export async function runFinalJudges(deps: RejudgeDeps): Promise<RejudgeOutcome> {
	const attempts: Record<string, number> = {};
	for (const judge of deps.judges) attempts[judge.name] = 0;

	for (;;) {
		// 限额触发后 session 已经 abort,再发 prompt 只会拿到一个立刻失败的 run。
		if (deps.shouldStop()) return { attempts };

		const context: JudgeContext = {
			lastAssistantText: deps.getLastAssistantText(),
			clauseIds: deps.getClauseIds(),
		};

		let dispatched = false;
		for (const judge of deps.judges) {
			const verdict = await judge.judge(context);
			if (verdict.ok) continue;

			if ((attempts[judge.name] ?? 0) >= judge.maxAttempts) {
				if (judge.onExhausted === "error") {
					return { attempts, errorMessage: `${judge.name}: ${verdict.detail ?? verdict.followUp}` };
				}
				continue; // pass:放过这个判官,继续看后面的
			}

			attempts[judge.name] = (attempts[judge.name] ?? 0) + 1;
			await deps.reprompt(verdict.followUp);
			dispatched = true;
			break; // 重跑**全部**判官 —— 补完证据后输出格式也可能变了
		}

		if (!dispatched) return { attempts };
	}
}

/** 只有对象和数组才尝试解析,所以字符串不会递归成无穷。 */
function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/**
 * 从任意形状的工具结果里挖 clause_id。
 *
 * 形状不固定是有原因的:MCP 工具结果常见形态是 `content[].text` 里塞一段 JSON 字符串,
 * 而不同工具的数组字段名各不相同(hits / cases / items / rows)。与其枚举形状,不如
 * 全深度找 key —— 找不到时 C6 的反幻觉校验会替我们响亮失败(basis 非空而 clauseIds 空)。
 */
export function collectClauseIds(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectClauseIds(item, out);
		return;
	}
	if (typeof value === "string") {
		const parsed = tryParseJson(value);
		if (parsed !== undefined) collectClauseIds(parsed, out);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, nested] of Object.entries(value)) {
		if (key === "clause_id") {
			if (typeof nested === "string" && nested.length > 0) out.add(nested);
			continue;
		}
		collectClauseIds(nested, out);
	}
}
