import { describe, expect, it } from "vitest";
import { resolveMode } from "../src/eval/mode.ts";

describe("resolveMode", () => {
	it("returns discover when only --discover is set", () => {
		expect(resolveMode({ discover: true })).toBe("discover");
	});

	it("returns probes when only --probes is set", () => {
		expect(resolveMode({ probes: true })).toBe("probes");
	});

	it("returns batch when neither --discover nor --probes is set", () => {
		expect(resolveMode({})).toBe("batch");
		expect(resolveMode({ discover: false, probes: false })).toBe("batch");
	});

	it("throws when --discover and --probes are both set, instead of silently picking one", () => {
		// 这是本轮要挡住的陷阱:--discover 分支若先命中就直接 return,--probes 会被静默丢弃
		// 且 exit code 仍是 0 —— 调用方只查 exit code 会误以为判据③已经跑过。必须响亮失败。
		expect(() => resolveMode({ discover: true, probes: true })).toThrow(/互斥/);
	});
});
