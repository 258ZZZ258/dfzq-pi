import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface ToolsetHandle {
	tools: ToolDefinition[];
	dispose?: () => Promise<void>;
}

export type ToolsetProvider = () => Promise<ToolDefinition[] | ToolsetHandle>;

/**
 * One `resolve()` call's worth of tools plus the cleanup for whatever it opened
 * (e.g. an MCP child process). Ownership is per-call, not per-registry: the caller
 * that resolved it is the caller that must eventually call `dispose()`, exactly once.
 */
export interface ResolvedToolset {
	tools: ToolDefinition[];
	dispose: () => Promise<void>;
}

const NOOP_DISPOSE = async (): Promise<void> => {};

/**
 * `providers` is process-level: toolset factories are registered once at startup and
 * never change. What each `resolve()` call opens (a live MCP child process, say) is
 * single-run-level and must not be tracked here -- two sessions sharing one registry
 * (or two concurrent runs of the same spec) would otherwise step on each other's
 * handles: one run's dispose() could tear down another run's still-live resources, or
 * find its own handle already spliced out from under it. The caller of `resolve()`
 * owns the returned `dispose`; this class only owns the provider lookup table.
 */
export class ToolsetRegistry {
	private readonly providers = new Map<string, ToolsetProvider>();

	register(id: string, provider: ToolsetProvider): void {
		if (this.providers.has(id)) {
			throw new Error(`Toolset "${id}" is already registered`);
		}
		this.providers.set(id, provider);
	}

	has(id: string): boolean {
		return this.providers.has(id);
	}

	ids(): Set<string> {
		return new Set(this.providers.keys());
	}

	async resolve(id: string): Promise<ResolvedToolset> {
		const provider = this.providers.get(id);
		if (!provider) throw new Error(`Toolset "${id}" is not registered`);
		const result = await provider();
		if (Array.isArray(result)) return { tools: result, dispose: NOOP_DISPOSE };
		return { tools: result.tools, dispose: result.dispose ?? NOOP_DISPOSE };
	}
}
