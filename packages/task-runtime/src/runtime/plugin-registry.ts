import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { type PluginRef, pluginName, pluginOptions } from "../spec/types.ts";

/**
 * 替换型 hook:返回值覆盖原值,同一 hook 挂两个插件会让后者静默盖掉前者。
 * 观察型 hook(turn_end / agent_end / session_compact 等)不在此列,可叠加。
 */
const REPLACING_HOOKS: ReadonlySet<string> = new Set([
	"tool_result",
	"context",
	"before_provider_request",
	"session_before_compact",
]);

export type PluginFactory = (options?: Record<string, unknown>) => InlineExtension;

export interface PluginDescriptor {
	name: string;
	/** 该插件挂了哪些 hook。用于装配期冲突校验。 */
	hooks: readonly string[];
	factory: PluginFactory;
}

export class PluginRegistry {
	private readonly descriptors = new Map<string, PluginDescriptor>();

	register(descriptor: PluginDescriptor): void {
		if (this.descriptors.has(descriptor.name)) {
			throw new Error(`Plugin "${descriptor.name}" is already registered`);
		}
		this.descriptors.set(descriptor.name, descriptor);
	}

	has(name: string): boolean {
		return this.descriptors.has(name);
	}

	names(): Set<string> {
		return new Set(this.descriptors.keys());
	}

	/** 解析并做替换型 hook 冲突校验。任何问题在装配期抛。 */
	resolveAll(refs: readonly PluginRef[]): InlineExtension[] {
		const claimed = new Map<string, string>();
		const out: InlineExtension[] = [];
		for (const ref of refs) {
			const name = pluginName(ref);
			const descriptor = this.descriptors.get(name);
			if (!descriptor) {
				throw new Error(`plugin "${name}" is not registered`);
			}
			for (const hook of descriptor.hooks) {
				if (!REPLACING_HOOKS.has(hook)) continue;
				const owner = claimed.get(hook);
				if (owner) {
					throw new Error(
						`replacing hook "${hook}" is claimed by both plugin "${owner}" and plugin "${name}". ` +
							`Replacing hooks overwrite their return value, so only one plugin may claim each.`,
					);
				}
				claimed.set(hook, name);
			}
			out.push(descriptor.factory(pluginOptions(ref)));
		}
		return out;
	}
}
