import { type PluginRef, pluginName, type RuntimeSpec } from "./types.ts";

export interface ValidateContext {
	knownToolsets: ReadonlySet<string>;
	knownPlugins: ReadonlySet<string>;
	knownRoles: ReadonlySet<string>;
}

/** 装配前的静态校验。任何失败都在这里抛,不拖到运行期。 */
export function validateSpec(spec: RuntimeSpec, ctx: ValidateContext): void {
	if (!spec.id) throw new Error("RuntimeSpec.id is required");
	if (spec.durableSession !== undefined && typeof spec.durableSession !== "boolean")
		throw new Error("RuntimeSpec.durableSession must be a boolean");

	if (!ctx.knownRoles.has(spec.model.role)) {
		throw new Error(
			`RuntimeSpec "${spec.id}": model role "${spec.model.role}" is not bound by the active ProviderProfile`,
		);
	}

	if (!ctx.knownToolsets.has(spec.toolset)) {
		throw new Error(`RuntimeSpec "${spec.id}": toolset "${spec.toolset}" is not registered`);
	}

	if (spec.toolMode !== undefined && spec.toolMode !== "none")
		throw new Error(`RuntimeSpec "${spec.id}": unknown toolMode`);
	if (spec.toolMode === "none" && (!Array.isArray(spec.tools) || spec.tools.length > 0 || spec.excludeTools?.length))
		throw new Error(
			`RuntimeSpec "${spec.id}": toolMode none requires an explicit empty tools list and no exclusions`,
		);
	if (!Array.isArray(spec.tools) || (spec.tools.length === 0 && spec.toolMode !== "none")) {
		throw new Error(
			`RuntimeSpec "${spec.id}": tools must be a non-empty whitelist ` +
				`(pi activates zero tools when noTools:"all" is set and tools is omitted)`,
		);
	}

	validateLimits(spec.limits, `RuntimeSpec "${spec.id}": limits`);

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
	if (spec.workflow !== undefined && spec.workflow !== "policy-compare" && spec.workflow !== "policy-version-diff") {
		throw new Error(`RuntimeSpec "${spec.id}": unknown workflow "${spec.workflow}"`);
	}

	// `workflow` 与 `fastPath` 是两条互不相交的路:前者整条换掉 Runtime 实现(连
	// SessionRuntime 都不经过),后者是 SessionRuntime 内部把模型调用压成固定 2 次。
	// 同时声明时 `fastPath` 会被**静默忽略**(确定性工作流的工厂分支根本不读它)——
	// 那正是本文件其余每一条校验都在防的形态,所以在装配期就拒掉。
	if (spec.workflow !== undefined && spec.fastPath !== undefined) {
		throw new Error(
			`RuntimeSpec "${spec.id}": workflow and fastPath are mutually exclusive ` +
				"(a workflow runtime never reads fastPath; declaring both would silently ignore it)",
		);
	}

	if (spec.fastPath !== undefined) {
		const fp = spec.fastPath;
		if (typeof fp.enabled !== "boolean") {
			throw new Error(`RuntimeSpec "${spec.id}": fastPath.enabled must be a boolean`);
		}
		for (const key of ["systemPrompt", "rewritePrompt", "answerPrompt"] as const) {
			if (typeof fp[key] !== "string" || fp[key].length === 0) {
				throw new Error(`RuntimeSpec "${spec.id}": fastPath.${key} must be a non-empty file path`);
			}
		}
		if (!Number.isInteger(fp.maxClauses) || fp.maxClauses < 1) {
			throw new Error(`RuntimeSpec "${spec.id}": fastPath.maxClauses must be an integer >= 1`);
		}
		if (typeof fp.limits !== "object" || fp.limits === null) {
			throw new Error(`RuntimeSpec "${spec.id}": fastPath.limits must be an object`);
		}
		validateLimits(fp.limits, `RuntimeSpec "${spec.id}": fastPath.limits`);
	}
}

function validateLimits(limits: unknown, path: string): void {
	if (typeof limits !== "object" || limits === null || Array.isArray(limits))
		throw new Error(`${path} must be an object`);
	const entries = Object.entries(limits).filter(([, value]) => value !== undefined);
	if (entries.length === 0) throw new Error(`${path} must set at least one limit`);
	for (const [key, value] of entries) {
		if (key !== "maxTurns" && key !== "runTimeoutMs")
			throw new Error(`${path}.${key} is unsupported; use maxTurns and runTimeoutMs`);
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
			throw new Error(`${path}.${key} must be a positive finite number`);
		if (key === "maxTurns" && !Number.isInteger(value))
			throw new Error(`${path}.maxTurns must be a positive integer`);
	}
}
