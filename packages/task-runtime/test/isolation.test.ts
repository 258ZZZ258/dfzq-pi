import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { PluginRegistry } from "../src/runtime/plugin-registry.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

function profileFor(provider: string): ProviderProfile {
	return {
		id: "test",
		baseUrl: "http://localhost/v1",
		apiKeyEnv: "TEST_KEY",
		api: "openai-completions",
		roles: {
			main: {
				provider,
				modelId: "faux",
				contextWindow: 8192,
				maxTokens: 1024,
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
	};
}

function toolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "Echo.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id: string, params: { text: string }) => ({ output: params.text, content: params.text }),
		} as never,
	]);
	return registry;
}

function spec(id: string, systemPrompt: string): RuntimeSpec {
	return {
		id,
		model: { role: "main" },
		toolset: "demo",
		tools: ["echo"],
		limits: { maxTurns: 5 },
		systemPrompt,
	};
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

describe("concurrent runtimes", () => {
	it("two specs run in parallel without cross-contaminating transcripts", async () => {
		const a = await createFauxHarness();
		const b = await createFauxHarness();
		cleanups.push(a.cleanup, b.cleanup);
		a.faux.setResponses([fauxAssistantMessage("ALPHA-ONLY")]);
		b.faux.setResponses([fauxAssistantMessage("BETA-ONLY")]);

		const runtimeA = await createSessionRuntime({
			spec: spec("alpha", "You are ALPHA."),
			profile: profileFor("faux"),
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: a.cwd,
			agentDir: a.agentDir,
			modelOverride: { modelRuntime: a.modelRuntime, model: a.model },
		});
		const runtimeB = await createSessionRuntime({
			spec: spec("beta", "You are BETA."),
			profile: profileFor("faux"),
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: b.cwd,
			agentDir: b.agentDir,
			modelOverride: { modelRuntime: b.modelRuntime, model: b.model },
		});
		cleanups.push(runtimeA.dispose, runtimeB.dispose);

		const [resultA, resultB] = await Promise.all([runtimeA.run("go"), runtimeB.run("go")]);

		expect(resultA.output).toContain("ALPHA-ONLY");
		expect(resultA.output).not.toContain("BETA-ONLY");
		expect(resultB.output).toContain("BETA-ONLY");
		expect(resultB.output).not.toContain("ALPHA-ONLY");
		expect(runtimeA.sessionId).not.toBe(runtimeB.sessionId);
		expect(runtimeA.specId).toBe("alpha");
		expect(runtimeB.specId).toBe("beta");
	});

	it("keeps event streams separate per runtime", async () => {
		const a = await createFauxHarness();
		const b = await createFauxHarness();
		cleanups.push(a.cleanup, b.cleanup);
		a.faux.setResponses([fauxAssistantMessage("A")]);
		b.faux.setResponses([fauxAssistantMessage("B")]);

		const runtimeA = await createSessionRuntime({
			spec: spec("alpha", "A"),
			profile: profileFor("faux"),
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: a.cwd,
			agentDir: a.agentDir,
			modelOverride: { modelRuntime: a.modelRuntime, model: a.model },
		});
		const runtimeB = await createSessionRuntime({
			spec: spec("beta", "B"),
			profile: profileFor("faux"),
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: b.cwd,
			agentDir: b.agentDir,
			modelOverride: { modelRuntime: b.modelRuntime, model: b.model },
		});
		cleanups.push(runtimeA.dispose, runtimeB.dispose);

		const specIdsA = new Set<string>();
		const specIdsB = new Set<string>();
		runtimeA.subscribe((event) => specIdsA.add(event.specId));
		runtimeB.subscribe((event) => specIdsB.add(event.specId));
		await Promise.all([runtimeA.run("go"), runtimeB.run("go")]);

		expect([...specIdsA]).toEqual(["alpha"]);
		expect([...specIdsB]).toEqual(["beta"]);
	});
});
