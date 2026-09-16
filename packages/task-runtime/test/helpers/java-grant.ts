import { generateKeyPairSync, sign } from "node:crypto";
import { ACTIONS, createGrantVerifier, type Grant } from "../../src/auth/grant.ts";

export function javaGrantFixture() {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const config = {
		issuer: "java-test",
		audience: "pi-test",
		keys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
	};
	const claims: Grant = {
		iss: config.issuer,
		aud: config.audience,
		tenantId: "t1",
		sub: "u1",
		sessionId: "s1",
		grantId: "g1",
		policyVersion: "1",
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 300,
		actions: [...ACTIONS],
		taskKinds: ["demo"],
		tools: ["echo"],
		dataScope: { corpusTypes: ["internal"], permTags: ["d1"] },
	};
	return {
		config,
		verifier: createGrantVerifier(config),
		claims,
		token(overrides: Partial<Grant> = {}) {
			const data = [
				Buffer.from(JSON.stringify({ alg: "RS256", typ: "pi-grant+jwt", kid: "test" })).toString("base64url"),
				Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url"),
			].join(".");
			return `${data}.${sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url")}`;
		},
	};
}
