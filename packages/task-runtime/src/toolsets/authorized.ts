import type { ToolsetProvider } from "./registry.ts";

/** Native toolsets need the same execution-time grant check as MCP tools. */
export function authorizedToolset(provider: ToolsetProvider, check: (name?: string) => Promise<void>): ToolsetProvider {
	return async (signal) => {
		signal?.throwIfAborted();
		await check();
		const result = await provider(signal);
		const handle = Array.isArray(result) ? { tools: result } : result;
		try {
			signal?.throwIfAborted();
			await check();
			return {
				...handle,
				tools: handle.tools.map((tool) => ({
					...tool,
					execute: async (...args: Parameters<typeof tool.execute>) => {
						args[2]?.throwIfAborted();
						await check(tool.name);
						const value = await tool.execute(...args);
						args[2]?.throwIfAborted();
						await check(tool.name);
						return value;
					},
				})),
			};
		} catch (error) {
			try {
				await handle.dispose?.();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "native toolset authorization and cleanup failed");
			}
			throw error;
		}
	};
}
