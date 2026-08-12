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
		// maxTurns 对快路径不适用(结构固定 2 次模型调用,FastPathSpec.limits 的文档已注明)——
		// 严格度对齐顶层 spec.limits 的既有判据(30-38 行):runTimeoutMs / maxCostUsd /
		// maxTotalTokens 至少命中一条,命中的每一项都必须是正数。挂钟硬顶(runTimeoutMs)缺失时
		// 快路径没有超时兜底,一次挂死会把两条路径的耗时相加。
		const fastPathLimitKeys = ["runTimeoutMs", "maxCostUsd", "maxTotalTokens"] as const;
		const fastPathLimitEntries = fastPathLimitKeys
			.map((key) => [key, fp.limits[key]] as const)
			.filter(([, value]) => value !== undefined);
		if (fastPathLimitEntries.length === 0) {
			throw new Error(
				`RuntimeSpec "${spec.id}": fastPath.limits must set at least one of runTimeoutMs, maxCostUsd, maxTotalTokens`,
			);
		}
		for (const [key, value] of fastPathLimitEntries) {
			if (typeof value !== "number" || value <= 0) {
				throw new Error(`RuntimeSpec "${spec.id}": fastPath.limits.${key} must be a positive number`);
			}
		}
	}
}
