import { auditReportReadinessDescriptor } from "../audit-report/report-readiness-gate.ts";
import { PluginRegistry } from "./plugin-registry.ts";
import { limitsDescriptor } from "./plugins/limits.ts";
import { pathGuardDescriptor } from "./plugins/path-guard.ts";
import { resultBudgetDescriptor } from "./plugins/result-budget.ts";
import { type AssessFn, createSufficiencyGateDescriptor } from "./plugins/sufficiency-gate.ts";

export interface DefaultPluginDeps {
	/**
	 * 测试缝:覆盖 `sufficiency-gate` 调 C1 `assess_sufficiency` 的默认实现。
	 *
	 * 生产不传 —— 插件缺省走 `PluginContext.callTool`,从本 run 已解析的工具里取。
	 * (此前这个字段缺省会让 sufficiency-gate **不被注册**,而两个生产调用点都不传 ⇒
	 * C3 在生产上永不可达。现在注册无条件,「C1 有没有接上」由装配期的工具名校验回答。)
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
	registry.register(createSufficiencyGateDescriptor(deps.assess));
	registry.register(auditReportReadinessDescriptor);
	return registry;
}
