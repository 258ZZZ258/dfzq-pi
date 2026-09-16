import { Type } from "typebox";
import { expect, it } from "vitest";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { capturingReply, createFauxHarness } from "./helpers/faux.ts";

it("stops before provider dispatch when execution authorization fails inside a Pi context hook", async () => {
	const harness = await createFauxHarness(),
		seen: string[] = [],
		toolsets = new ToolsetRegistry();
	toolsets.register("test", async () => [
		{
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
		},
	]);
	harness.faux.setResponses([capturingReply("must not run", seen)]);
	const runtime = await createSessionRuntime({
		spec: { id: "demo", model: { role: "main" }, tools: ["echo"], toolset: "test", limits: { maxTurns: 3 } },
		profile: {
			id: "faux",
			baseUrl: "http://local",
			apiKeyEnv: "TEST",
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
		},
		registry: createDefaultPluginRegistry(),
		toolsets,
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		modelOverride: { model: harness.model, modelRuntime: harness.modelRuntime },
		onCheckpoint: async () => {},
		authorizeExecution: async () => {
			throw new Error("authorization_revoked");
		},
	});
	try {
		const result = await runtime.run("sensitive context");
		expect(result.status).toBe("error");
		expect(seen).toEqual([]);
	} finally {
		await runtime.dispose();
		await harness.cleanup();
	}
});
