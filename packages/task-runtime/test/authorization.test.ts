import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { authorize, constrainFilters, createGrantVerifier } from "../src/auth/grant.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
	issuer: "java",
	audience: "pi",
	keys: { k1: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
	now: () => 1800000000000,
};
const claims = {
	iss: "java",
	aud: "pi",
	sub: "u1",
	tenantId: "t1",
	sessionId: "s1",
	grantId: "g1",
	policyVersion: "1",
	iat: 1800000000,
	exp: 1800000300,
	actions: ["run:create", "run:read", "run:steer"],
	taskKinds: ["demo"],
	tools: ["search"],
	dataScope: { corpusTypes: ["internal"], permTags: ["d1", "d2"] },
};
function jwt(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
	const body = [
		Buffer.from(JSON.stringify({ alg: "RS256", typ: "pi-grant+jwt", kid: "k1", ...header })).toString("base64url"),
		Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url"),
	].join(".");
	return `${body}.${sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url")}`;
}
it("verifies the Java grant and restricts action, session and task kind", () => {
	const grant = createGrantVerifier(config).verify(jwt());
	expect(grant.sub).toBe("u1");
	expect(() => authorize(grant, "run:steer", { sessionId: "s1", taskKind: "demo" }, 1800000000000)).not.toThrow();
	expect(() => authorize(grant, "run:cancel", { sessionId: "s1" }, 1800000000000)).toThrow("forbidden");
	expect(() => authorize(grant, "run:read", { sessionId: "other" }, 1800000000000)).toThrow("forbidden");
});
it("rejects invalid signatures, wrong algorithms/audiences, expiration and oversized lifetime", () => {
	const verifier = createGrantVerifier(config);
	for (const token of [
		jwt({ aud: "other" }),
		jwt({ exp: 1799999999 }),
		jwt({ exp: 1800003600 }),
		jwt({}, { alg: "HS256" }),
		jwt({}, { kid: "unknown" }),
		`${jwt().split(".").slice(0, 2).join(".")}.AAAA`,
	])
		expect(() => verifier.verify(token)).toThrow("unauthorized");
});
it("intersects data scope and fails closed on empty intersections", () => {
	const grant = createGrantVerifier(config).verify(jwt());
	expect(constrainFilters(grant, { corpusTypes: ["internal", "external"], permTags: ["d2", "admin"] })).toEqual({
		corpusTypes: ["internal"],
		permTags: ["d2"],
	});
	expect(constrainFilters(grant, { corpusTypes: ["internal"] }).permTags).toEqual(["d1", "d2"]);
	expect(() => constrainFilters(grant, { corpusTypes: ["external"] })).toThrow("forbidden");
	expect(() => constrainFilters(grant, { corpusTypes: ["internal"], permTags: [] })).toThrow("forbidden");
});
