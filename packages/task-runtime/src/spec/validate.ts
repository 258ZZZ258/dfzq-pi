import { type PluginRef, pluginName, type RuntimeSpec } from "./types.ts";

export interface ValidateContext {
	knownToolsets: ReadonlySet<string>;
	knownPlugins: ReadonlySet<string>;
	knownRoles: ReadonlySet<string>;
}

/** 装配前的静态校验。任何失败都在这里抛,不拖到运行期。 */
export function validateSpec(spec: RuntimeSpec, ctx: ValidateContext): void {
	if (!spec.id) throw new Error("RuntimeSpec.id is required");

	if (!ctx.knownRoles.has(spec.model.role)) {
		throw new Error(
			`RuntimeSpec "${spec.id}": model role "${spec.model.role}" is not bound by the active ProviderProfile`,
		);
	}

	if (!ctx.knownToolsets.has(spec.toolset)) {
		throw new Error(`RuntimeSpec "${spec.id}": toolset "${spec.toolset}" is not registered`);
	}

	if (!Array.isArray(spec.tools) || spec.tools.length === 0) {
		throw new Error(
			`RuntimeSpec "${spec.id}": tools must be a non-empty whitelist ` +
				`(pi activates zero tools when noTools:"all" is set and tools is omitted)`,
		);
	}

	const limitKeys = Object.entries(spec.limits).filter(([, value]) => value !== undefined);
	if (limitKeys.length === 0) {
		throw new Error(`RuntimeSpec "${spec.id}": limits must set at least one limit`);
	}
	for (const [key, value] of limitKeys) {
		if (typeof value !== "number" || value <= 0) {
			throw new Error(`RuntimeSpec "${spec.id}": limits.${key} must be a positive number`);
		}
	}

	const refs: Array<PluginRef | undefined> = [
		spec.contextStrategy,
		spec.stopPolicy,
		spec.resultPolicy,
		spec.approvalPolicy,
		...(spec.extraPlugins ?? []),
	];
	for (const ref of refs) {
		if (!ref) continue;
		const name = pluginName(ref);
		if (!ctx.knownPlugins.has(name)) {
			throw new Error(`RuntimeSpec "${spec.id}": plugin "${name}" is not registered`);
		}
	}

	if (spec.outputContract !== undefined) {
		if (typeof spec.outputContract.schema !== "string" || spec.outputContract.schema.length === 0) {
			throw new Error(`RuntimeSpec "${spec.id}": outputContract.schema must be a non-empty path`);
		}
		const attempts = spec.outputContract.maxRepairAttempts;
		if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 0)) {
			throw new Error(`RuntimeSpec "${spec.id}": outputContract.maxRepairAttempts must be a non-negative integer`);
		}
	}

	// 取值写死而不是「非空即放行」:工厂是按这个字符串分派的,拼错一个字母会让 spec
	// 静默退回 SessionRuntime —— 那条路上模型看得见工具、能自主编排,与本 spec 的
	// 全部不变量(固定调用次数、正文不由模型产)背道而驰,且不会有任何报错。
	if (spec.workflow !== undefined && spec.workflow !== "policy-compare") {
		throw new Error(`RuntimeSpec "${spec.id}": unknown workflow "${spec.workflow}"`);
	}
}
