import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { validateSpec } from "../src/spec/validate.ts";

const spec = JSON.parse(
	readFileSync(fileURLToPath(new URL("../specs/policy-compare-coverage.json", import.meta.url)), "utf8"),
) as RuntimeSpec;

// spec 不声明任何 PluginRef(见 spec 文件的 $comment:刻意不配 stopPolicy/resultPolicy),
// 所以 knownPlugins 恒为空集也够用 —— 但 ValidateContext.knownPlugins 是必填字段
// (src/spec/validate.ts 的 ValidateContext 接口,不是可选),漏了编译不过。
const ctx = {
	knownToolsets: new Set(["policy-compare"]),
	knownPlugins: new Set<string>(),
	knownRoles: new Set(["main"]),
};

describe("policy-compare-coverage.json", () => {
	it("通过 validateSpec", () => {
		expect(() => validateSpec(spec, ctx)).not.toThrow();
	});

	it("workflow 声明为 policy-compare", () => {
		expect(spec.workflow).toBe("policy-compare");
	});

	// 🔴 这条是本任务真正的失败驱动力。`validateSpec` **没有顶层字段白名单**(读码确认),
	// 所以「spec 里多一个 workflow 字段」本身不会被拒 —— 上面那条断言在改代码之前就能跑绿。
	// 只有「未知 workflow 取值必须被拒」这条,在 validate.ts 补上校验之前必然红。
	it("未知的 workflow 取值被 validateSpec 拒绝", () => {
		expect(() => validateSpec({ ...spec, workflow: "不存在的工作流" } as unknown as RuntimeSpec, ctx)).toThrow(
			/workflow/,
		);
	});

	it("护栏定值与规格 §3.5 一致", () => {
		expect(spec.limits.runTimeoutMs).toBe(1_800_000);
		expect(spec.limits.maxCostUsd).toBe(2.0);
	});

	// maxTurns 必须严格大于 ceil(MAX_OBLIGATIONS / 最小 batchSize)。最坏情况
	// MAX_OBLIGATIONS=500、batchSize 下界 1 ⇒ 500 批。撞到 maxTurns 时 PolicyCompareRuntime
	// fail-closed(status: "limit_exceeded",不返回 output)—— 断言具体数值,防止后人随手把
	// 600 调小到刚好等于甚至小于 500 而不知道后果。
	it("maxTurns=600,严格大于最坏情况下的 500 批(MAX_OBLIGATIONS=500 / batchSize 下界 1)", () => {
		expect(spec.limits.maxTurns).toBe(600);
		expect(spec.limits.maxTurns as number).toBeGreaterThan(500);
	});

	it("不声明 stopPolicy / resultPolicy(两者在本 runtime 上不成立)", () => {
		expect(spec.stopPolicy).toBeUndefined();
		expect(spec.resultPolicy).toBeUndefined();
	});

	it("tools 非空 —— validate.ts 拒绝空白名单,模型看不见是 runtime 装配后做的事", () => {
		expect(spec.tools.length).toBeGreaterThan(0);
	});
});
