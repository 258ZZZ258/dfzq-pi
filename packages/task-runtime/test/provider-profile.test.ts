import { afterEach, describe, expect, it } from "vitest";
import { type ProviderProfile, profileRoles, requireApiKey, resolveRole } from "../src/env/provider-profile.ts";

const profile: ProviderProfile = {
	id: "vllm-intranet",
	baseUrl: "http://gateway.internal/v1",
	apiKeyEnv: "DFZQ_LLM_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "dfzq-gateway",
			modelId: "qwen3-32b",
			contextWindow: 131072,
			maxTokens: 8192,
			reasoning: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

afterEach(() => {
	delete process.env.DFZQ_LLM_KEY;
});

describe("ProviderProfile", () => {
	it("resolves a bound role", () => {
		expect(resolveRole(profile, "main").modelId).toBe("qwen3-32b");
	});

	it("throws on an unbound role", () => {
		expect(() => resolveRole(profile, "judge")).toThrow(/role "judge"/);
	});

	it("lists role names", () => {
		expect(profileRoles(profile).has("main")).toBe(true);
	});

	it("reads the api key from env", () => {
		process.env.DFZQ_LLM_KEY = "secret";
		expect(requireApiKey(profile)).toBe("secret");
	});

	it("throws when the env var is unset, naming the variable", () => {
		expect(() => requireApiKey(profile)).toThrow(/DFZQ_LLM_KEY/);
	});
});
