import { describe, expect, it, vi } from "vitest";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { FinalJudge } from "../src/runtime/final-judge.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { createSufficiencyGateDescriptor, extractMatters } from "../src/runtime/plugins/sufficiency-gate.ts";

function makeContext(judges: FinalJudge[], runInput = "问题正文"): PluginContext {
	return {
		getRunId: () => "r1",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: (judge) => judges.push(judge),
		getRunInput: () => runInput,
		callTool: async () => ({}),
	};
}

// 复审 I-1:extractMatters 是 brief 列明的导出接口,C1 接线之前它是 matters:"auto" 的唯一实现,
// 空 matters 会让 gate 静默退化成 no-op(assess 拿到 [] 很容易被判 sufficient:true)。这里直接
// 钉住它的边界行为,不再只靠"sufficiency-gate"describe 里那两条从不断言 matters 的 auto 用例。
describe("extractMatters", () => {
	it("returns an empty array for empty input", () => {
		expect(extractMatters("")).toEqual([]);
	});

	// 4 字阈值会吃掉 brief 自己举例用的三字事项名("适当性")—— 已知边界,记录而非本任务修复项:
	// C1 尚未接线,无法验证 assess 对短 matters 的真实容忍度。
	it("drops a matter name shorter than the 4-character threshold", () => {
		expect(extractMatters("适当性")).toEqual([]);
	});

	it("splits on the Chinese period / (半角或全角)分号 / newline, dropping fragments under 4 characters", () => {
		expect(extractMatters("第一句话。第二句;第三")).toEqual(["第一句话"]);
	});
});

describe("sufficiency-gate", () => {
	it("registers exactly one final judge and claims no hooks", () => {
		const judges: FinalJudge[] = [];
		const descriptor = createSufficiencyGateDescriptor(async () => ({ sufficient: true, covered: [], missing: [] }));
		expect(descriptor.hooks).toEqual([]);
		descriptor.factory(makeContext(judges), { maxProbes: 2, matters: "auto" });
		expect(judges).toHaveLength(1);
		expect(judges[0]?.name).toBe("sufficiency-gate");
		expect(judges[0]?.maxAttempts).toBe(2);
		// 证据不足不是错误 —— 由输出契约的 confidence / gaps 表达。
		expect(judges[0]?.onExhausted).toBe("pass");
	});

	it("passes when assess reports sufficient evidence", async () => {
		const judges: FinalJudge[] = [];
		createSufficiencyGateDescriptor(async () => ({ sufficient: true, covered: ["a"], missing: [] })).factory(
			makeContext(judges),
			{},
		);
		const verdict = await judges[0]!.judge({ lastAssistantText: "结论", clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(true);
	});

	it("asks for more evidence and names the gaps when assess reports insufficient", async () => {
		const judges: FinalJudge[] = [];
		createSufficiencyGateDescriptor(async () => ({
			sufficient: false,
			covered: ["适当性"],
			missing: ["留痕要求"],
		})).factory(makeContext(judges), {});
		const verdict = await judges[0]!.judge({ lastAssistantText: "结论", clauseIds: ["A-1"] });
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.followUp).toContain("适当性");
			expect(verdict.followUp).toContain("留痕要求");
		}
	});

	it("passes the run's clause ids and the resolved matters to assess", async () => {
		const judges: FinalJudge[] = [];
		const assess = vi.fn(async () => ({ sufficient: true, covered: [], missing: [] }));
		createSufficiencyGateDescriptor(assess).factory(makeContext(judges), { matters: ["合规性"] });
		await judges[0]!.judge({ lastAssistantText: "结论", clauseIds: ["A-1", "A-2"] });
		expect(assess).toHaveBeenCalledWith(["A-1", "A-2"], ["合规性"]);
	});

	// 复审 I-1:此前两条走 auto 路径的用例(options = {})都没断言传给 assess 的 matters ——
	// 只有显式 matters 的用例断言过。这条把 auto 路径本身钉住:matters 未声明或声明为 "auto"
	// 时,assess 收到的必须是 extractMatters(ctx.getRunInput()) 的结果,不是空数组或原文整段。
	it('resolves matters:"auto" via extractMatters against the run\'s input', async () => {
		const judges: FinalJudge[] = [];
		const assess = vi.fn(async () => ({ sufficient: true, covered: [], missing: [] }));
		createSufficiencyGateDescriptor(assess).factory(makeContext(judges, "问题正文"), {});
		await judges[0]!.judge({ lastAssistantText: "结论", clauseIds: [] });
		expect(assess).toHaveBeenCalledWith([], ["问题正文"]);
	});

	it("defaults maxProbes to 2", () => {
		const judges: FinalJudge[] = [];
		createSufficiencyGateDescriptor(async () => ({ sufficient: true, covered: [], missing: [] })).factory(
			makeContext(judges),
			{},
		);
		expect(judges[0]?.maxAttempts).toBe(2);
	});
});

describe("createDefaultPluginRegistry + assess", () => {
	it("registers sufficiency-gate when an assess implementation is supplied", () => {
		const registry = createDefaultPluginRegistry({
			assess: async () => ({ sufficient: true, covered: [], missing: [] }),
		});
		expect(registry.has("sufficiency-gate")).toBe(true);
	});

	it("registers sufficiency-gate even without an injected assess", () => {
		// 旧契约是「assess 缺省就不注册」,理由是不静默放宽。但代价太大:两个生产调用点
		// (server/main.ts、cli/main.ts)都不传 deps ⇒ C3 在生产上**永不可达**,
		// 而「永不可达」比「静默放宽」更糟 —— 它连声明这个插件的机会都没有。
		//
		// 新契约:插件缺省从 PluginContext.callTool 调 C1。「C1 有没有接上」由装配期的
		// 工具名校验回答 —— spec 的 toolset 不提供 assess_sufficiency 时,
		// callTool 会抛「this run's toolset does not provide」。fail-closed 没有丢,
		// 只是从**注册期**挪到了**调用期**,而且错误信息更指向病因。
		expect(createDefaultPluginRegistry().has("sufficiency-gate")).toBe(true);
	});
});

describe("assessViaTool 的判定依据(C3 改语义后的核心)", () => {
	function gateWith(toolResult: unknown) {
		const judges: FinalJudge[] = [];
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const descriptor = createSufficiencyGateDescriptor(); // 不注入 assess ⇒ 走 callTool
		descriptor.factory(
			{
				getRunId: () => "r-1",
				getSession: () => {
					throw new Error("unused");
				},
				abort: () => {},
				limitState: { turns: 0 },
				registerFinalJudge: (j) => judges.push(j),
				getRunInput: () => "第一个待查要点。第二个待查要点。",
				callTool: async (name, args) => {
					calls.push({ name, args });
					return toolResult;
				},
			},
			{},
		);
		return { judge: judges[0], calls };
	}

	const context = { clauseIds: ["a", "b"], lastText: "", attempt: 0 } as never;

	it("rejects when some retrieved clauses were never fetched, even if the count says sufficient", async () => {
		// **这条是改语义的全部意义**:C1 的 hit_count_sufficient 只是 len(candidates)>=min_hits
		// 的计数,底层 assess() 不做任何语义判定。真正有判定力的是 unfetched ——
		// 「检索到了却没取正文就下结论」。拿计数当判据 = 这个判官形同虚设。
		const { judge } = gateWith({ hit_count_sufficient: true, unfetched: ["a"], retrieved_count: 2 });
		const verdict = await judge.judge(context);
		expect(verdict.ok).toBe(false);
		// JudgeVerdict 是可辨识联合,ok:true 那支没有 followUp —— 先窄化再读。
		if (verdict.ok) throw new Error("expected a rejection");
		expect(verdict.followUp).toContain("a");
	});

	it("passes when everything retrieved has been fetched", async () => {
		const { judge } = gateWith({ hit_count_sufficient: false, unfetched: [], retrieved_count: 2 });
		const verdict = await judge.judge(context);
		expect(verdict.ok).toBe(true);
	});

	it("calls C1's assess_sufficiency with the extracted matters", async () => {
		const { judge, calls } = gateWith({ unfetched: [] });
		await judge.judge(context);
		expect(calls[0]?.name).toBe("assess_sufficiency");
		// extractMatters 会丢掉长度 < 4 的片段(它按中文标点切分,过短的多半是语气词),
		// 所以这里的要点要够长 —— 写短了会拿到空数组而误以为是接线断了。
		expect(calls[0]?.args.matters).toEqual(["第一个待查要点", "第二个待查要点"]);
	});

	it("treats a missing unfetched field as nothing outstanding rather than crashing", async () => {
		const { judge } = gateWith({});
		expect((await judge.judge(context)).ok).toBe(true);
	});
});
