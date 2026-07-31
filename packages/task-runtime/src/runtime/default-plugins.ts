import { PluginRegistry } from "./plugin-registry.ts";
import { limitsDescriptor } from "./plugins/limits.ts";

/** 进程级插件表的依赖注入点。Task 9 会加 assess。 */
export interface DefaultPluginDeps {}

/**
 * 唯一的进程级插件表来源。**所有生产路径都必须用它**,不要再 `new PluginRegistry()` ——
 * 空表会让 assemble() 在 lookup "limits" 时直接抛(这是刻意的响亮失败,不要加兜底)。
 */
export function createDefaultPluginRegistry(_deps: DefaultPluginDeps = {}): PluginRegistry {
	const registry = new PluginRegistry();
	registry.register(limitsDescriptor);
	return registry;
}
