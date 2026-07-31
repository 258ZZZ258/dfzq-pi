import { describe, expect, it, vi } from "vitest";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { FinalJudge } from "../src/runtime/final-judge.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { createSufficiencyGateDescriptor } from "../src/runtime/plugins/sufficiency-gate.ts";

function makeContext(judges: FinalJudge[], runInput = "问题正文"): PluginContext {
	return {
		specId: "policy-query",
		getRunId: () => "r1",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: (judge) => judges.push(judge),
		getRunInput: () => runInput,
	};
}

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

	it("does NOT register sufficiency-gate when assess is missing", () => {
		// 不静默放宽:C1 的 assess_sufficiency 还没接线时,声明了这个插件的 spec 必须
		// 在装配期响亮失败,而不是悄悄跳过充分性判定。
		expect(createDefaultPluginRegistry().has("sufficiency-gate")).toBe(false);
	});
});
