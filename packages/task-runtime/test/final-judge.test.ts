import { describe, expect, it, vi } from "vitest";
import { collectClauseIds, type FinalJudge, runFinalJudges } from "../src/runtime/final-judge.ts";

/**
 * reprompt 的 mock。形参类型要显式写出来:`vi.fn(async () => {})` 会被推成**零参** mock,
 * 于是 `mock.calls[0]?.[0]` 在 tsgo 下报 TS2493(长度 0 的元组没有下标 0)。
 * 签名与 RejudgeDeps.reprompt 对齐才是本意。
 */
function repromptMock() {
	return vi.fn(async (_text: string) => {});
}

function judge(name: string, verdicts: Array<{ ok: boolean }>, overrides: Partial<FinalJudge> = {}): FinalJudge {
	let call = 0;
	return {
		name,
		maxAttempts: 2,
		onExhausted: "pass",
		judge: async () => {
			const verdict = verdicts[Math.min(call, verdicts.length - 1)];
			call += 1;
			return verdict?.ok ? { ok: true } : { ok: false, followUp: `${name} 不通过`, detail: `${name} detail` };
		},
		...overrides,
	};
}

describe("runFinalJudges", () => {
	it("returns immediately when every judge passes", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: true }]), judge("b", [{ ok: true }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).not.toHaveBeenCalled();
		expect(outcome.errorMessage).toBeUndefined();
		expect(outcome.attempts).toEqual({ a: 0, b: 0 });
	});

	it("dispatches the first failing judge and re-runs all judges after the reprompt", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }, { ok: true }]), judge("b", [{ ok: true }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(1);
		expect(reprompt).toHaveBeenCalledWith("a 不通过");
		expect(outcome.attempts).toEqual({ a: 1, b: 0 });
	});

	it("runs judges in registration order — the first one wins the reprompt", async () => {
		const reprompt = repromptMock();
		await runFinalJudges({
			judges: [judge("first", [{ ok: false }, { ok: true }]), judge("second", [{ ok: false }, { ok: true }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt.mock.calls[0]?.[0]).toBe("first 不通过");
	});

	// Task 8 (C6):C6 必须在装配期**追加在**插件登记的判官(如 C3 的 sufficiency-gate)之后。
	// 这里不需要真 session —— 只要证明 runFinalJudges 按 judges 数组顺序派发,而 session-runtime.ts
	// 的接线保证了这个数组顺序(assemble() 内部的 registerFinalJudge 先跑,C6 在 assemble()
	// 返回之后才 push)。两者都不通过时,先派发的必须是排在前面的 sufficiency-gate。
	it("dispatches sufficiency-gate's followUp before output-contract's when both judges fail (C3 before C6)", async () => {
		const reprompt = repromptMock();
		await runFinalJudges({
			judges: [
				judge("sufficiency-gate", [{ ok: false }, { ok: true }]),
				judge("output-contract", [{ ok: false }, { ok: true }]),
			],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt.mock.calls[0]?.[0]).toBe("sufficiency-gate 不通过");
	});

	it("passes over an exhausted judge whose onExhausted is pass", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }], { maxAttempts: 1, onExhausted: "pass" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(1);
		expect(outcome.errorMessage).toBeUndefined();
		expect(outcome.attempts).toEqual({ a: 1 });
	});

	it("reports an error for an exhausted judge whose onExhausted is error", async () => {
		const outcome = await runFinalJudges({
			judges: [judge("c6", [{ ok: false }], { maxAttempts: 2, onExhausted: "error" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt: async () => {},
			shouldStop: () => false,
		});
		expect(outcome.attempts).toEqual({ c6: 2 });
		expect(outcome.errorMessage).toContain("c6 detail");
	});

	it("stops rejudging when shouldStop reports a tripped limit", async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }])],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => true,
		});
		expect(reprompt).not.toHaveBeenCalled();
		expect(outcome.errorMessage).toBeUndefined();
	});

	// 终止性锁。算法的每轮循环只有两个出口:派发一次 reprompt(把某个判官的 attempts +1),
	// 或者直接 return。attempts 单调递增且被 maxAttempts 封顶,所以循环轮数 ≤ Σ maxAttempts + 1。
	// 这两条用例把那个上界钉死:判官**恒**不通过时 reprompt 次数必须正好等于 Σ maxAttempts,
	// 多一次就是漏了封顶,不收敛就是死循环(timeout 会让它响亮失败而不是挂住 vitest)。
	it("terminates after exactly maxAttempts reprompts when a judge never passes", { timeout: 5000 }, async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [judge("never", [{ ok: false }], { maxAttempts: 3, onExhausted: "pass" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(3);
		expect(outcome.attempts).toEqual({ never: 3 });
		expect(outcome.errorMessage).toBeUndefined();
	});

	// 审查 I-1 的回归锁。轮首的 shouldStop() 与 reprompt 之间隔着 `await judge.judge(context)`,
	// 限额在那段 await 里翻 true 是常规结局(C3/C6 的判官要走秒级的 MCP assess 调用)。
	// 少了 reprompt 前的复查,这里会多发一次 prompt —— 而那次 prompt 没有 turn 上限、没有挂钟
	// 上限、也没有在途 abort(abort 在 pi 里不粘滞、runTimeout 的 setTimeout 是一次性的、
	// limits 插件 tripped 后永久停止计数),run() 会一直阻塞到模型自然停止。
	it("does not dispatch a reprompt when the limit trips while a judge is awaiting", { timeout: 5000 }, async () => {
		const reprompt = repromptMock();
		let tripped = false;
		const outcome = await runFinalJudges({
			judges: [
				{
					name: "slow",
					maxAttempts: 3,
					onExhausted: "pass",
					judge: async () => {
						// 模拟"判官 await 期间限额到期":轮首那次 shouldStop() 已经放行了。
						tripped = true;
						return { ok: false, followUp: "继续查证" };
					},
				},
			],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => tripped,
		});
		expect(reprompt).not.toHaveBeenCalled();
		// 这一轮没有真的花掉一次尝试,所以不记账。
		expect(outcome.attempts).toEqual({ slow: 0 });
		expect(outcome.errorMessage).toBeUndefined();
	});

	// 审查 M-1 的回归锁:判官抛异常时,已经花掉的 attempts 不能跟着丢。
	it("keeps the attempts already spent when a judge throws", async () => {
		const reprompt = repromptMock();
		let call = 0;
		const outcome = await runFinalJudges({
			judges: [
				{
					name: "flaky",
					maxAttempts: 5,
					onExhausted: "pass",
					judge: async () => {
						call += 1;
						if (call <= 2) return { ok: false, followUp: "继续查证" };
						throw new Error("assess 调用失败");
					},
				},
			],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		expect(reprompt).toHaveBeenCalledTimes(2);
		expect(outcome.attempts).toEqual({ flaky: 2 }); // 不是 {}
		expect(outcome.errorMessage).toContain("assess 调用失败");
	});

	it("keeps the attempts already spent when the reprompt itself throws", async () => {
		let call = 0;
		const outcome = await runFinalJudges({
			judges: [judge("a", [{ ok: false }], { maxAttempts: 5, onExhausted: "pass" })],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt: async () => {
				call += 1;
				if (call >= 2) throw new Error("prompt 炸了");
			},
			shouldStop: () => false,
		});
		expect(outcome.attempts).toEqual({ a: 2 });
		expect(outcome.errorMessage).toContain("prompt 炸了");
	});

	it("bounds the total reprompts by the sum of maxAttempts across judges", { timeout: 5000 }, async () => {
		const reprompt = repromptMock();
		const outcome = await runFinalJudges({
			judges: [
				judge("a", [{ ok: false }], { maxAttempts: 2, onExhausted: "pass" }),
				judge("b", [{ ok: false }], { maxAttempts: 2, onExhausted: "pass" }),
			],
			getLastAssistantText: () => "text",
			getClauseIds: () => [],
			reprompt,
			shouldStop: () => false,
		});
		// a 先用尽自己的 2 次,被 pass 放过之后才轮到 b 的 2 次 —— 总数 = Σ maxAttempts = 4。
		expect(reprompt).toHaveBeenCalledTimes(4);
		expect(outcome.attempts).toEqual({ a: 2, b: 2 });
	});
});

describe("collectClauseIds", () => {
	it("finds clause_id at any depth, including inside JSON-encoded strings", () => {
		const out = new Set<string>();
		collectClauseIds(
			{
				content: [{ type: "text", text: JSON.stringify({ hits: [{ clause_id: "A-1" }, { clause_id: "A-2" }] }) }],
				nested: { deeper: [{ clause_id: "B-1" }] },
			},
			out,
		);
		expect([...out].sort()).toEqual(["A-1", "A-2", "B-1"]);
	});

	it("ignores non-string and empty clause_id values", () => {
		const out = new Set<string>();
		collectClauseIds({ clause_id: 1 }, out);
		collectClauseIds({ clause_id: "" }, out);
		expect(out.size).toBe(0);
	});

	it("does not recurse forever on a plain string", () => {
		const out = new Set<string>();
		collectClauseIds("just text", out);
		collectClauseIds('"quoted"', out);
		expect(out.size).toBe(0);
	});

	// 审查 I-3 的回归锁。这个函数跑在 pi 无 try/catch 的 _emit 里,抛 RangeError 会直接打死
	// 在跑的 run。result 是 AgentToolResult = { content, details },details 是工具私有结构、
	// 不进 provider 请求,因此不受"必须可序列化"约束 —— 装得下环。
	it("survives a cyclic structure and still collects the ids it can reach", { timeout: 5000 }, () => {
		const out = new Set<string>();
		const node: Record<string, unknown> = { clause_id: "C-1" };
		node.self = node;
		// 环 + 分叉:只有深度上限没有环检测时,这种形状会先炸在指数级路径数上而不是栈深度上。
		node.children = [node, { clause_id: "C-2", back: node }, { deeper: { back: node, clause_id: "C-3" } }];
		expect(() => collectClauseIds(node, out)).not.toThrow();
		expect([...out].sort()).toEqual(["C-1", "C-2", "C-3"]);
	});

	it("survives a chain deeper than the recursion cap instead of blowing the stack", { timeout: 5000 }, () => {
		const out = new Set<string>();
		// 纯链状、无环:每个节点都是新对象,环检测一次都不命中 —— 只有深度上限救得了它。
		let deep: Record<string, unknown> = { clause_id: "TOO-DEEP" };
		for (let i = 0; i < 50_000; i += 1) deep = { nested: deep };
		expect(() => collectClauseIds(deep, out)).not.toThrow();
		// 越界子树静默不再贡献 id —— 刻意的降级,由 C6 的反幻觉校验兜底。
		expect(out.size).toBe(0);
	});

	it("still reaches clause_id at a depth a real tool result would use", () => {
		const out = new Set<string>();
		// content[] → text 里的 JSON → hits[] → clause_id,约 6 层,离 64 的上限很远。
		collectClauseIds({ content: [{ text: JSON.stringify({ hits: [{ clause_id: "OK-1" }] }) }] }, out);
		expect([...out]).toEqual(["OK-1"]);
	});

	// 审查 I-1 的回归锁:C4 result-budget 的 maxChars 截断是对已序列化 JSON 的原始字符裁切,
	// 截断点落在结构中间时产出的文本对 JSON.parse 是非法输入,但对模型仍然可读(同一份
	// finalized.result.content 既喂 tool_execution_end、也喂模型看到的 tool result 消息)。
	// "A-1" 的 `"clause_id":"A-1"` 子串在截断点之前、字面完整,模型能读到并合法引用;
	// "A-2" 的值被截断点切断(`"clause_id":"A-2` 缺右引号),模型也看不到完整值 —— 两条
	// 分别验证"能读到的必须采到"与"读不全的两边同样一无所获、不构成新的不一致"。
	it("recovers a clause_id via regex when maxChars truncation breaks the JSON (I-1)", () => {
		const out = new Set<string>();
		const truncated = '{"total":5,"hits":[{"clause_id":"A-1"},{"clause_id":"A-2\n…[已截断,原长 314 字符]';
		collectClauseIds({ content: [{ type: "text", text: truncated }] }, out);
		expect([...out]).toEqual(["A-1"]);
	});

	// looksLikeJson 门槛的回归锁:正则兜底只应该落在"本来是 JSON、只是解析失败"的文本上,
	// 不应该扩大到任何提到 clause_id 字样的自然语言备注 —— 否则命中面会远超"截断坏掉的
	// JSON"这一个场景。这段备注不以 { 或 [ 开头,不满足 looksLikeJson。
	it("does not regex-scan a prose string that merely mentions clause_id-shaped text", () => {
		const out = new Set<string>();
		collectClauseIds({ note: 'see also "clause_id":"DECOY" for context' }, out);
		expect(out.size).toBe(0);
	});
});
