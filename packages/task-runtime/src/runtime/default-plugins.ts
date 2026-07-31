import { PluginRegistry } from "./plugin-registry.ts";
import { limitsDescriptor } from "./plugins/limits.ts";
import { pathGuardDescriptor } from "./plugins/path-guard.ts";
import { resultBudgetDescriptor } from "./plugins/result-budget.ts";
import { type AssessFn, createSufficiencyGateDescriptor } from "./plugins/sufficiency-gate.ts";

export interface DefaultPluginDeps {
	/**
	 * C1 policy-query-mcp 的 assess_sufficiency。**缺省时 sufficiency-gate 不会被注册**,
	 * 于是声明了它的 spec 在装配期报 `plugin "sufficiency-gate" is not registered`。
	 * 这是刻意的 fail-closed:C1 没接线时不许静默跳过充分性判定(权限红线「不静默放宽」)。
	 */
	assess?: AssessFn;
}

/**
 * 唯一的进程级插件表来源。**所有生产路径都必须用它**,不要再 `new PluginRegistry()` ——
 * 空表会让 assemble() 在 lookup "limits" 时直接抛(这是刻意的响亮失败,不要加兜底)。
 */
export function createDefaultPluginRegistry(deps: DefaultPluginDeps = {}): PluginRegistry {
	const registry = new PluginRegistry();
	registry.register(limitsDescriptor);
	registry.register(resultBudgetDescriptor);
	registry.register(pathGuardDescriptor);
	if (deps.assess) registry.register(createSufficiencyGateDescriptor(deps.assess));
	return registry;
}
