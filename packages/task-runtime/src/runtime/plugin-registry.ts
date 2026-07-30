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

/** 一个已定位到描述符的插件条目(还未实例化)。 */
export interface PluginEntry {
	descriptor: PluginDescriptor;
	options?: Record<string, unknown>;
}

/**
 * 实例化一组已定位的插件,并做替换型 hook 冲突校验。
 *
 * 故意做成自由函数而不是 PluginRegistry 的方法:per-run 的内置插件(limits 等)的描述符
 * 闭包捕获了本次 run 的状态,不能进进程级的 registry(见下方 PluginRegistry 的说明),
 * 但它们和 spec 声明的进程级插件最终挂在同一个 session 上,所以必须参与**同一次**冲突
 * 校验 —— 绕过 registry 不等于可以绕过这层保护。
 */
export function instantiatePlugins(entries: readonly PluginEntry[]): InlineExtension[] {
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
		out.push(descriptor.factory(options));
	}
	return out;
}

/**
 * `descriptors` 是**进程级**的:插件在启动时注册一次,之后不再变。任何 per-run 状态
 * (LimitState、本次 run 的 abort 句柄……)都不得通过 register() 进到这里 —— 这与
 * toolsets/registry.ts 里 `providers` 的不变量是同一条。违反它的直接后果:同一个
 * PluginRegistry 第二次被复用就撞 "already registered",而 S1a 的并发请求与 S3 的按
 * specId 池化本来就要求一个 registry 被反复复用。per-run 插件走 assemble() 的
 * `builtinPlugins`(直接传描述符实例),不经过这张表。
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
	resolveAll(refs: readonly PluginRef[]): InlineExtension[] {
		return instantiatePlugins(this.lookupAll(refs));
	}
}
