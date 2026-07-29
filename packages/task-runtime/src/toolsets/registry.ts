import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface ToolsetHandle {
	tools: ToolDefinition[];
	dispose?: () => Promise<void>;
}

export type ToolsetProvider = () => Promise<ToolDefinition[] | ToolsetHandle>;

export class ToolsetRegistry {
	private readonly providers = new Map<string, ToolsetProvider>();
	private readonly opened: Array<() => Promise<void>> = [];

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

	async resolve(id: string): Promise<ToolDefinition[]> {
		const provider = this.providers.get(id);
		if (!provider) throw new Error(`Toolset "${id}" is not registered`);
		const result = await provider();
		if (Array.isArray(result)) return result;
		if (result.dispose) this.opened.push(result.dispose);
		return result.tools;
	}

	async disposeAll(): Promise<void> {
		const failures: unknown[] = [];
		for (const dispose of this.opened.splice(0).reverse()) {
			try {
				await dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Toolset disposal failed");
	}
}
