import { createPublicKey, type KeyObject, verify } from "node:crypto";
import type { RunFilters } from "../server/run-manager.ts";
import { hashState } from "../state/json.ts";

export const ACTIONS = [
	"run:create",
	"run:read",
	"run:cancel",
	"run:resume",
	"run:renew",
	"run:steer",
	"run:follow_up",
	"memory:read",
	"memory:write",
	"memory:approve",
	"library:read",
] as const;
export type Action = (typeof ACTIONS)[number];
export interface Principal {
	tenantId: string;
	userId: string;
}
export interface Grant {
	iss: string;
	aud: string;
	sub: string;
	tenantId: string;
	sessionId: string;
	grantId: string;
	policyVersion: string;
	iat: number;
	exp: number;
	nbf?: number;
	actions: Action[];
	taskKinds: string[];
	tools: string[];
	dataScope: {
		corpusTypes: string[];
		permTags: string[];
		projectId?: string;
		owner?: string;
		includeSuperseded?: boolean;
	};
}
export interface GrantVerifier {
	verify(token: string): Grant;
}
export interface GrantConfig {
	issuer: string;
	audience: string;
	keys: Record<string, string>;
	maxLifetimeSeconds?: number;
	now?: () => number;
}
export class AuthorizationError extends Error {
	readonly status: 401 | 403;
	constructor(code: "unauthorized" | "forbidden") {
		super(code);
		this.status = code === "unauthorized" ? 401 : 403;
	}
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function strings(value: unknown, allowEmpty = false): value is string[] {
	return (
		Array.isArray(value) &&
		(allowEmpty || value.length > 0) &&
		value.length <= 256 &&
		value.every(nonempty) &&
		new Set(value).size === value.length
	);
}
export function createGrantVerifier(config: GrantConfig): GrantVerifier {
	if (!nonempty(config.issuer) || !nonempty(config.audience) || !config.keys || !Object.keys(config.keys).length)
		throw new Error("grant_configuration_invalid");
	const lifetime = config.maxLifetimeSeconds ?? 300;
	if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 3600) throw new Error("grant_configuration_invalid");
	const keys = new Map<string, KeyObject>();
	for (const [kid, pem] of Object.entries(config.keys)) {
		const key = createPublicKey(pem);
		if (!nonempty(kid) || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
			throw new Error("grant_key_invalid");
		keys.set(kid, key);
	}
	return {
		verify(token) {
			try {
				if (typeof token !== "string" || token.length > 32768) throw new Error("token_size");
				const parts = token.split(".");
				if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error("token_format");
				const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
				const key = typeof header.kid === "string" ? keys.get(header.kid) : undefined;
				if (!key || header.alg !== "RS256" || header.typ !== "pi-grant+jwt" || header.crit !== undefined)
					throw new Error("token_header");
				if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url")))
					throw new Error("signature");
				const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Grant;
				const now = Math.floor((config.now ?? Date.now)() / 1000);
				if (
					!value ||
					value.iss !== config.issuer ||
					value.aud !== config.audience ||
					![value.sub, value.tenantId, value.sessionId, value.grantId, value.policyVersion].every(nonempty) ||
					!Number.isSafeInteger(value.iat) ||
					!Number.isSafeInteger(value.exp) ||
					value.iat > now + 5 ||
					value.exp <= now ||
					value.exp <= value.iat ||
					value.exp - value.iat > lifetime ||
					(value.nbf !== undefined && (!Number.isSafeInteger(value.nbf) || value.nbf > now + 5))
				)
					throw new Error("claims");
				if (
					!strings(value.actions) ||
					!value.actions.every((a) => ACTIONS.includes(a)) ||
					!strings(value.taskKinds) ||
					!strings(value.tools, true) ||
					!value.dataScope ||
					!strings(value.dataScope.corpusTypes) ||
					!strings(value.dataScope.permTags)
				)
					throw new Error("scope");
				for (const field of [value.dataScope.projectId, value.dataScope.owner])
					if (field !== undefined && !nonempty(field)) throw new Error("scope");
				if (
					value.dataScope.includeSuperseded !== undefined &&
					typeof value.dataScope.includeSuperseded !== "boolean"
				)
					throw new Error("scope");
				return value;
			} catch {
				throw new AuthorizationError("unauthorized");
			}
		},
	};
}
export function authorize(
	grant: Grant,
	action: Action,
	resource: { sessionId?: string; taskKind?: string; principal?: Principal },
	now = Date.now(),
): void {
	if (grant.exp * 1000 <= now) throw new AuthorizationError("unauthorized");
	if (
		!grant.actions.includes(action) ||
		(resource.sessionId !== undefined && resource.sessionId !== grant.sessionId) ||
		(resource.taskKind !== undefined && !grant.taskKinds.includes(resource.taskKind)) ||
		(resource.principal &&
			(resource.principal.tenantId !== grant.tenantId || resource.principal.userId !== grant.sub))
	)
		throw new AuthorizationError("forbidden");
}
export function constrainFilters(grant: Grant, requested: RunFilters): RunFilters {
	const corpusTypes = [...new Set(requested.corpusTypes)].filter((c) => grant.dataScope.corpusTypes.includes(c));
	const permTags = [...new Set(requested.permTags ?? grant.dataScope.permTags)].filter((p) =>
		grant.dataScope.permTags.includes(p),
	);
	if (!corpusTypes.length || !permTags.length) throw new AuthorizationError("forbidden");
	const result: RunFilters = { corpusTypes, permTags };
	for (const name of ["projectId", "owner"] as const) {
		const allowed = grant.dataScope[name],
			selected = requested[name];
		if (allowed !== undefined && selected != null && selected !== allowed) throw new AuthorizationError("forbidden");
		if (allowed !== undefined || selected !== undefined) result[name] = allowed ?? selected;
	}
	return result;
}
/** Stable context compatibility; refreshing only expiry/grantId does not change scope. */
export function grantScopeHash(grant: Grant): string {
	return hashState({
		tenantId: grant.tenantId,
		userId: grant.sub,
		sessionId: grant.sessionId,
		policyVersion: grant.policyVersion,
		tools: [...grant.tools].sort(),
		dataScope: {
			...grant.dataScope,
			corpusTypes: [...grant.dataScope.corpusTypes].sort(),
			permTags: [...grant.dataScope.permTags].sort(),
		},
	});
}
