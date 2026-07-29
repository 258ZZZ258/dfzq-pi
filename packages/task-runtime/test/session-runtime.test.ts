import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { PluginRegistry } from "../src/runtime/plugin-registry.ts";
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

function toolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "Echo the input back.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id: string, params: { text: string }) => ({ output: params.text, content: params.text }),
		} as never,
	]);
	return registry;
}

function spec(limits: RuntimeSpec["limits"]): RuntimeSpec {
	return { id: "demo", model: { role: "main" }, toolset: "demo", tools: ["echo"], limits };
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

async function build(limits: RuntimeSpec["limits"], responses: unknown[]) {
	const harness = await createFauxHarness();
	cleanups.push(harness.cleanup);
	harness.faux.setResponses(responses as never);
	const runtime = await createSessionRuntime({
		spec: spec(limits),
		profile,
		registry: new PluginRegistry(),
		toolsets: toolsets(),
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	});
	cleanups.push(runtime.dispose);
	return runtime;
}

describe("SessionRuntime", () => {
	it("returns a completed RunResult with usage and timing", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const result = await runtime.run("hello");
		expect(result.status).toBe("completed");
		expect(result.output).toContain("done");
		expect(result.runId).toMatch(/.+/);
		expect(result.turns).toBeGreaterThanOrEqual(1);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.usage.total).toBeGreaterThanOrEqual(0);
	});

	it("accepts a caller-supplied runId", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const result = await runtime.run("hello", { runId: "run-42" });
		expect(result.runId).toBe("run-42");
	});

	it("reports limit_exceeded with limit=runTimeout when the run times out", async () => {
		const runtime = await build({ runTimeoutMs: 1 }, [
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve(fauxAssistantMessage("late")), 200);
				}),
		]);
		const result = await runtime.run("hello");
		expect(result.status).toBe("limit_exceeded");
		expect(result.limit).toBe("runTimeout");
	});

	it("emits enveloped events with monotonically increasing seq", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		const seen: number[] = [];
		const unsubscribe = runtime.subscribe((event) => {
			expect(event.runId).toBeTruthy();
			expect(event.specId).toBe("demo");
			seen.push(event.seq);
		});
		await runtime.run("hello");
		unsubscribe();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("exposes a snapshot with the session id", async () => {
		const runtime = await build({ maxTurns: 5 }, [fauxAssistantMessage("done")]);
		expect(runtime.snapshot().sessionId).toBe(runtime.sessionId);
	});
});
