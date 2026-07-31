import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
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
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: a.cwd,
			agentDir: a.agentDir,
			modelOverride: { modelRuntime: a.modelRuntime, model: a.model },
		});
		const runtimeB = await createSessionRuntime({
			spec: spec("beta", "You are BETA."),
			profile: profileFor("faux"),
			registry: createDefaultPluginRegistry(),
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
		// RunResult.specId must tag each result with its own spec, so two interleaved runs
		// stay attributable without a side channel (final fix round, finding 4).
		expect(resultA.specId).toBe("alpha");
		expect(resultB.specId).toBe("beta");
	});

	it("keeps event streams separate per runtime", async () => {
		const a = await createFauxHarness();
		const b = await createFauxHarness();
		cleanups.push(a.cleanup, b.cleanup);
		a.faux.setResponses([fauxAssistantMessage("ALPHA-EVENT-ONLY")]);
		b.faux.setResponses([fauxAssistantMessage("BETA-EVENT-ONLY")]);

		const runtimeA = await createSessionRuntime({
			spec: spec("alpha", "A"),
			profile: profileFor("faux"),
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: a.cwd,
			agentDir: a.agentDir,
			modelOverride: { modelRuntime: a.modelRuntime, model: a.model },
		});
		const runtimeB = await createSessionRuntime({
			spec: spec("beta", "B"),
			profile: profileFor("faux"),
			registry: createDefaultPluginRegistry(),
			toolsets: toolsets(),
			cwd: b.cwd,
			agentDir: b.agentDir,
			modelOverride: { modelRuntime: b.modelRuntime, model: b.model },
		});
		cleanups.push(runtimeA.dispose, runtimeB.dispose);

		const specIdsA = new Set<string>();
		const specIdsB = new Set<string>();
		// event.specId (session-runtime.ts) is a per-runtime closure constant -- it stays
		// "alpha"/"beta" even if the underlying event's *content* leaked in from the other
		// runtime (e.g. a provider-registration collision routing B's queued response into
		// A's stream). Collect the serialized payloads too, so a content-level leak fails
		// this test instead of only a specId-tagging leak going undetected.
		const payloadsA: string[] = [];
		const payloadsB: string[] = [];
		runtimeA.subscribe((event) => {
			specIdsA.add(event.specId);
			payloadsA.push(JSON.stringify(event.payload));
		});
		runtimeB.subscribe((event) => {
			specIdsB.add(event.specId);
			payloadsB.push(JSON.stringify(event.payload));
		});
		await Promise.all([runtimeA.run("go"), runtimeB.run("go")]);

		expect([...specIdsA]).toEqual(["alpha"]);
		expect([...specIdsB]).toEqual(["beta"]);

		const serializedA = payloadsA.join("\n");
		const serializedB = payloadsB.join("\n");
		expect(serializedA).toContain("ALPHA-EVENT-ONLY");
		expect(serializedA).not.toContain("BETA-EVENT-ONLY");
		expect(serializedB).toContain("BETA-EVENT-ONLY");
		expect(serializedB).not.toContain("ALPHA-EVENT-ONLY");
	});

	// Regression lock (final fix round, finding 1): every other test in this file hands each
	// runtime its own registry, which is exactly what hid the per-run-state leak --
	// createSessionRuntime() registered the limits descriptor into the caller's registry, so
	// the second call against a shared one threw `Plugin "limits" is already registered`. A
	// PluginRegistry is process-level; two concurrent runtimes must be able to share one.
	// Task 5 起 limits 是 createDefaultPluginRegistry() 里的进程级描述符,per-run 状态全部
	// 走 PluginContext —— 这条锁因此更强了:共享的表里现在**真的有**插件。
	it("runs two runtimes concurrently off one shared PluginRegistry without interfering", async () => {
		const a = await createFauxHarness();
		const b = await createFauxHarness();
		cleanups.push(a.cleanup, b.cleanup);
		a.faux.setResponses([fauxAssistantMessage("ALPHA-SHARED-REGISTRY")]);
		b.faux.setResponses([fauxAssistantMessage("BETA-SHARED-REGISTRY")]);

		const shared = createDefaultPluginRegistry();
		const [runtimeA, runtimeB] = await Promise.all([
			createSessionRuntime({
				spec: spec("alpha", "You are ALPHA."),
				profile: profileFor("faux"),
				registry: shared,
				toolsets: toolsets(),
				cwd: a.cwd,
				agentDir: a.agentDir,
				modelOverride: { modelRuntime: a.modelRuntime, model: a.model },
			}),
			createSessionRuntime({
				spec: spec("beta", "You are BETA."),
				profile: profileFor("faux"),
				registry: shared,
				toolsets: toolsets(),
				cwd: b.cwd,
				agentDir: b.agentDir,
				modelOverride: { modelRuntime: b.modelRuntime, model: b.model },
			}),
		]);
		cleanups.push(runtimeA.dispose, runtimeB.dispose);

		const [resultA, resultB] = await Promise.all([runtimeA.run("go"), runtimeB.run("go")]);

		expect(resultA.status).toBe("completed");
		expect(resultB.status).toBe("completed");
		expect(resultA.output).toContain("ALPHA-SHARED-REGISTRY");
		expect(resultA.output).not.toContain("BETA-SHARED-REGISTRY");
		expect(resultB.output).toContain("BETA-SHARED-REGISTRY");
		expect(resultB.output).not.toContain("ALPHA-SHARED-REGISTRY");

		// The shared registry stayed process-level: two runtimes only *looked up* out of it,
		// nothing per-run got registered in. Its contents are still exactly what
		// createDefaultPluginRegistry() put there.
		expect([...shared.names()]).toEqual(["limits", "result-budget", "path-guard", "sufficiency-gate"]);
	});
});
