import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createFastPathRuntime } from "../src/runtime/fast-path-runtime.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

const answerSchema = {
	type: "object",
	required: ["conclusion", "basis", "finish_reason", "confidence"],
	properties: {
		conclusion: { type: "string" },
		basis: {
			type: "array",
			items: { type: "object", required: ["clause_id"], properties: { clause_id: { type: "string" } } },
		},
		finish_reason: { enum: ["stop", "refused"] },
		confidence: { enum: ["high", "medium", "low"] },
	},
} as const;

const validAnswer = JSON.stringify({
	conclusion: "允许",
	basis: [{ clause_id: "C-1" }],
	finish_reason: "stop",
	confidence: "high",
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function sessionToolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id: string, params: { text: string }) => ({ output: params.text, content: params.text }),
		} as never,
	]);
	return registry;
}

function fastToolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("policy", async () => [
		{
			name: "search_policy",
			label: "Search policy",
			description: "Search policy clauses",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => {
				const payload = JSON.stringify({
					hits: [{ clause_id: "C-1", score: 1, source_code: "S", source_doc_id: "D" }],
					total: 1,
					text_available: false,
				});
				return { output: payload, content: payload };
			},
		} as never,
		{
			name: "get_clause_detail",
			label: "Get clause detail",
			description: "Load policy clause text",
			parameters: Type.Object({ clause_ids: Type.Array(Type.String()) }),
			execute: async () => {
				const payload = JSON.stringify({
					items: [{ clause_id: "C-1", doc_title: "制度", clause_path: "第一条", text: "真实正文" }],
					rejected: [],
					not_found: [],
				});
				return { output: payload, content: payload };
			},
		} as never,
	]);
	return registry;
}

describe("sticky user cancellation", () => {
	it("does not start a C6 repair prompt after SessionRuntime.abort()", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return fauxAssistantMessage("incomplete draft");
			},
			fauxAssistantMessage(validAnswer),
		]);

		const spec: RuntimeSpec = {
			id: "session-cancel",
			model: { role: "main" },
			toolset: "demo",
			tools: ["echo"],
			limits: { maxTurns: 10 },
			outputContract: { schema: "answer.schema.json", maxRepairAttempts: 1 },
		};
		const runtime = await createSessionRuntime({
			spec,
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: sessionToolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			outputContractSchema: answerSchema,
		});
		cleanups.push(runtime.dispose);

		const running = runtime.run("问题");
		await waitUntil(() => !runtime.isIdle);
		await runtime.abort();
		const result = await running;

		expect.soft(harness.faux.state.callCount).toBe(1);
		expect.soft(result.status).toBe("aborted");
	});

	it("does not start the fast-path answer call after aborting the rewrite call", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return fauxAssistantMessage(JSON.stringify({ queries: ["改写词"] }));
			},
			fauxAssistantMessage(validAnswer),
		]);

		const spec: RuntimeSpec = {
			id: "fast-cancel",
			model: { role: "main" },
			toolset: "policy",
			tools: ["search_policy", "get_clause_detail"],
			limits: { maxTurns: 10 },
			fastPath: {
				enabled: true,
				systemPrompt: "制度查询",
				rewritePrompt: "改写问题",
				answerPrompt: "依据证据回答",
				maxClauses: 3,
				limits: { maxTurns: 10 },
			},
		};
		const runtime = await createFastPathRuntime({
			spec,
			profile,
			registry: createDefaultPluginRegistry(),
			toolsets: fastToolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			outputContractSchema: answerSchema,
		});
		cleanups.push(runtime.dispose);

		const running = runtime.runFast("原始问题");
		await waitUntil(() => !runtime.isIdle);
		await runtime.abort();
		const outcome = await running;

		expect.soft(harness.faux.state.callCount).toBe(1);
		expect.soft(outcome.result.status).toBe("aborted");
	});
});
