import { describe, expect, it } from "vitest";
import { checkInternalToken } from "../src/server/middleware/auth.ts";

describe("internal token check", () => {
	it("closes the boundary when the server token is not configured", () => {
		expect(checkInternalToken("anything", undefined)).toBe("boundary_closed");
		expect(checkInternalToken(undefined, "")).toBe("boundary_closed");
	});

	it("rejects a missing header", () => {
		expect(checkInternalToken(undefined, "secret")).toBe("unauthorized");
	});

	it("rejects a wrong token", () => {
		expect(checkInternalToken("wrong", "secret")).toBe("unauthorized");
	});

	it("rejects a token that only shares a prefix", () => {
		expect(checkInternalToken("sec", "secret")).toBe("unauthorized");
	});

	it("accepts the right token", () => {
		expect(checkInternalToken("secret", "secret")).toBe("ok");
	});

	it("compares different-length tokens without throwing", () => {
		// timingSafeEqual 要求等长 buffer;不先取摘要就会在这里抛
		expect(() => checkInternalToken("a", "aaaaaaaaaaaaaaaaaaaaaaaa")).not.toThrow();
		expect(checkInternalToken("a", "aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("unauthorized");
	});
});
