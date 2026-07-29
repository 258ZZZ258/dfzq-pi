import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.ts";

describe("scaffold", () => {
	it("exports the package name", () => {
		expect(PACKAGE_NAME).toBe("@dfzq/task-runtime");
	});

	it("can import pi-coding-agent from workspace source", async () => {
		const mod = await import("@earendil-works/pi-coding-agent");
		expect(typeof mod.createAgentSession).toBe("function");
		expect(typeof mod.SettingsManager.inMemory).toBe("function");
	});
});
