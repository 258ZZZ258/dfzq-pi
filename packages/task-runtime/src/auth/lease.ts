import type { StateStore } from "../state/store.ts";
import { type Grant, grantScopeHash } from "./grant.ts";

interface LeaseRecord {
	version: 1;
	scopeHash: string;
	grant: Grant;
	revoked: boolean;
}
/** Raw bearer tokens are never persisted. Only verified claims enter this port. */
export class GrantLease {
	readonly store: StateStore;
	constructor(store: StateStore) {
		this.store = store;
	}
	private key(rootRunId: string): string {
		return JSON.stringify(["grant-lease", rootRunId]);
	}
	async renew(rootRunId: string, grant: Grant): Promise<void> {
		if (grant.exp * 1000 <= Date.now()) throw new Error("authorization_expired");
		for (let i = 0; i < 8; i++) {
			const prior = await this.store.get(this.key(rootRunId));
			const value = prior?.value as LeaseRecord | undefined;
			if (value && (value.version !== 1 || value.scopeHash !== grantScopeHash(grant)))
				throw new Error("authorization_scope_changed");
			if (value?.revoked) throw new Error("authorization_revoked");
			if (value && value.grant.exp >= grant.exp) return;
			if (
				await this.store.compareAndSwap(this.key(rootRunId), prior?.revision ?? null, {
					version: 1,
					scopeHash: grantScopeHash(grant),
					grant,
					revoked: false,
				})
			)
				return;
		}
		throw new Error("authorization_lease_busy");
	}
	async current(rootRunId: string, expected: Grant): Promise<Grant> {
		const value = (await this.store.get(this.key(rootRunId)))?.value as LeaseRecord | undefined;
		if (!value || value.version !== 1 || value.scopeHash !== grantScopeHash(expected))
			throw new Error("authorization_lease_missing_or_changed");
		if (value.revoked) throw new Error("authorization_revoked");
		if (value.grant.exp * 1000 <= Date.now()) throw new Error("authorization_expired");
		return value.grant;
	}
	async revoke(rootRunId: string, expected: Grant): Promise<void> {
		for (let i = 0; i < 8; i++) {
			const prior = await this.store.get(this.key(rootRunId));
			const value = prior?.value as LeaseRecord | undefined;
			if (value && value.scopeHash !== grantScopeHash(expected))
				throw new Error("authorization_lease_missing_or_changed");
			if (value?.revoked) return;
			if (
				await this.store.compareAndSwap(this.key(rootRunId), prior?.revision ?? null, {
					...(value ?? { version: 1, scopeHash: grantScopeHash(expected), grant: expected }),
					revoked: true,
				})
			)
				return;
		}
		throw new Error("authorization_lease_busy");
	}
}
