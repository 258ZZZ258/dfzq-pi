import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { assemble } from "../src/runtime/assembler.ts";
import { PluginRegistry } from "../src/runtime/plugin-registry.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: { main: { provider: "faux", modelId: "faux", contextWindow: 8192, maxTokens: 1024 } },
};

function spec(overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
	return {
		id: "demo",
		model: { role: "main" },
		toolset: "demo",
		tools: ["echo"],
		limits: { maxTurns: 5 },
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

function toolsets(): ToolsetRegistry {
	const registry = new ToolsetRegistry();
	registry.register("demo", async () => [
		{
			name: "echo",
			label: "Echo",
			description: "Echo the input back.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id: string, params: { text: string }) => ({
				output: params.text,
				content: params.text,
			}),
		} as never,
	]);
	return registry;
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

describe("assemble", () => {
	it("builds a session with only the whitelisted tool active", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		const assembled = await assemble({
			spec: spec(),
			profile,
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		expect(assembled.session.getActiveToolNames()).toEqual(["echo"]);
	});

	it("runs a prompt end to end against the faux provider", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		harness.faux.setResponses([fauxAssistantMessage("hello from faux")]);
		const assembled = await assemble({
			spec: spec(),
			profile,
			registry: new PluginRegistry(),
			toolsets: toolsets(),
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
		});
		cleanups.push(assembled.dispose);
		await assembled.session.prompt("hi");
		expect(assembled.session.getLastAssistantText()).toContain("hello from faux");
	});

	it("fails at assembly time when the toolset is unknown", async () => {
		const harness = await createFauxHarness();
		cleanups.push(harness.cleanup);
		await expect(
			assemble({
				spec: spec({ toolset: "missing" }),
				profile,
				registry: new PluginRegistry(),
				toolsets: toolsets(),
				cwd: harness.cwd,
				agentDir: harness.agentDir,
				modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
			}),
		).rejects.toThrow(/toolset "missing"/);
	});
});
