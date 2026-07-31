import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import { type PluginRef, pluginName, pluginOptions } from "../spec/types.ts";
import type { LimitState } from "./contract.ts";
import type { FinalJudge } from "./final-judge.ts";

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

/**
 * 一次装配(= 一个 SessionRuntime)的上下文。插件在**实例化时**从这里拿 per-run 依赖,
 * 这样 PluginRegistry 可以回归它的进程级定位:描述符启动时注册一次,状态在实例化时注入。
 *
 * getSession / getRunId 必须是**惰性句柄**,不能换成实例字段:插件在 assemble() 的
 * 内部被实例化,那时 AgentSession 还没造出来;runId 则在 S3 按 specId 池化之后会
 * 一个 session 跨多个 run 地变。
 */
export interface PluginContext {
	specId: string;
	getRunId: () => string;
	getSession: () => AgentSession;
	abort: () => void;
	limitState: LimitState;
	/**
	 * 插件在**实例化时**登记终局判官。判官由 SessionRuntime.run() 在 prompt() 返回后
	 * 统一驱动 —— 插件自己够不着那个时点(hook 只看得见单轮),所以这是它参与终局判定
	 * 的唯一通路。登记顺序即执行顺序。
	 */
	registerFinalJudge: (judge: FinalJudge) => void;
	/** 本 run 的输入正文。matters:"auto" 从这里抽。run() 未开始时返回空串。 */
	getRunInput: () => string;
}

export type PluginFactory = (ctx: PluginContext, options?: Record<string, unknown>) => InlineExtension;

export interface PluginDescriptor {
	name: string;
	/** 该插件挂了哪些 hook。用于装配期冲突校验。 */
	hooks: readonly string[];
	factory: PluginFactory;
}

/** 一个已定位到描述符的插件条目(还未实例化)。 */
export interface PluginEntry {
	descriptor: PluginDescriptor;
	options?: Record<string, unknown>;
}

/**
 * 实例化一组已定位的插件,并做替换型 hook 冲突校验。
 *
 * 做成自由函数而不是 PluginRegistry 的方法:调用方(assembler)要把 spec 声明的插件与
 * 无条件挂载的 limits 拼成同一张表,再做**一次**冲突校验 —— 分两次校验等于两个插件
 * 各自认为自己独占了同一个替换型 hook。
 */
export function instantiatePlugins(entries: readonly PluginEntry[], ctx: PluginContext): InlineExtension[] {
	const claimed = new Map<string, string>();
	const out: InlineExtension[] = [];
	for (const { descriptor, options } of entries) {
		for (const hook of descriptor.hooks) {
			if (!REPLACING_HOOKS.has(hook)) continue;
			const owner = claimed.get(hook);
			if (owner) {
				throw new Error(
					`replacing hook "${hook}" is claimed by both plugin "${owner}" and plugin "${descriptor.name}". ` +
						`Replacing hooks overwrite their return value, so only one plugin may claim each.`,
				);
			}
			claimed.set(hook, descriptor.name);
		}
		out.push(descriptor.factory(ctx, options));
	}
	return out;
}

/**
 * `descriptors` 是**进程级**的:插件在启动时注册一次,之后不再变。任何 per-run 状态
 * (LimitState、本次 run 的 abort 句柄……)都不得通过 register() 进到这里 —— 这与
 * toolsets/registry.ts 里 `providers` 的不变量是同一条。违反它的直接后果:同一个
 * PluginRegistry 第二次被复用就撞 "already registered",而 S1a 的并发请求与 S3 的按
 * specId 池化本来就要求一个 registry 被反复复用。per-run 状态一律走 PluginContext
 * (实例化时注入),没有第二条绕开这张表的通路。
 *
 * 唯一合法的构造入口是 default-plugins.ts 的 createDefaultPluginRegistry():裸
 * `new PluginRegistry()` 是空表,assemble() 会在 lookup "limits" 时直接抛。
 */
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

	/** 只把插件名定位到描述符,不实例化。未注册的名字在这里抛(装配期失败要早)。
	 *  调用方拿到条目后与自己的 per-run 内置插件拼在一起,交给 instantiatePlugins()
	 *  做统一的冲突校验 —— 见 assembler.ts。 */
	lookupAll(refs: readonly PluginRef[]): PluginEntry[] {
		return refs.map((ref) => {
			const name = pluginName(ref);
			const descriptor = this.descriptors.get(name);
			if (!descriptor) {
				throw new Error(`plugin "${name}" is not registered`);
			}
			return { descriptor, options: pluginOptions(ref) };
		});
	}

	/** 解析并做替换型 hook 冲突校验。任何问题在装配期抛。 */
	resolveAll(refs: readonly PluginRef[], ctx: PluginContext): InlineExtension[] {
		return instantiatePlugins(this.lookupAll(refs), ctx);
	}
}
