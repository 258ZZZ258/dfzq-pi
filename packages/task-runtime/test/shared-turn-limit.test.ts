import { expect, it } from "vitest";
import { deriveFastSpec } from "../src/runtime/fast-path-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";

it.each([undefined, 10, 1])("fast path cannot exceed the parent turn limit (local=%s)", (local) => {
	const spec: RuntimeSpec = {
		id: "demo",
		model: { role: "main" },
		toolset: "demo",
		tools: ["echo"],
		limits: { maxTurns: 2 },
		fastPath: {
			enabled: true,
			systemPrompt: "a",
			rewritePrompt: "b",
			answerPrompt: "c",
			maxClauses: 1,
			limits: { runTimeoutMs: 1000, ...(local === undefined ? {} : { maxTurns: local }) },
		},
	};
	const fast = deriveFastSpec(spec);
	expect(fast.limits.maxTurns).toBe(local === 1 ? 1 : 2);
	expect(spec.limits.maxTurns).toBe(2);
});
