import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PluginContext, PluginDescriptor } from "../plugin-registry.ts";

export const PATH_GUARD_PLUGIN_NAME = "path-guard";

export interface PathGuardOptions {
	/** 支持 <runId> 占位符,在**每次调用时**(不是实例化时)由 ctx.getRunId() 展开。 */
	allowRoots?: string[];
}

interface ToolCallEvent {
	toolName?: string;
	input?: unknown;
}

/**
 * pi 的内置 `read` 工具当前进不来任何用这个插件的 run:`assembler.ts` 用 `noTools: "all"`
 * 关掉了 pi 全部内置工具、只接 `toolsets.resolve()` 解析出的自定义工具,且同一处的工具名
 * 交叉校验会在装配期拒绝任何 spec 里出现的未知工具名 —— 这与 result-budget.ts 顶部注释
 * 记录的架构巧合是同一个前提。所以本插件的测试直接拿 hook handler 测(见
 * test/path-guard.test.ts 里的假 ExtensionAPI),不去起一个真会调 `read` 的 session。
 * 这不是缺陷:一旦装配层将来放开内置工具(或某个自定义工具集也叫自己 "read"),这个
 * hook 会立刻对它生效,不需要改这个文件——tool_call 是观察型 hook(不在
 * plugin-registry.ts 的 REPLACING_HOOKS 里),可以和其他 tool_call 插件叠加。
 */
export const pathGuardDescriptor: PluginDescriptor = {
	name: PATH_GUARD_PLUGIN_NAME,
	hooks: ["tool_call"],
	factory: (ctx: PluginContext, rawOptions?: Record<string, unknown>) => {
		const options = (rawOptions ?? {}) as PathGuardOptions;
		const roots = options.allowRoots ?? [];
		return {
			name: PATH_GUARD_PLUGIN_NAME,
			factory: (pi: ExtensionAPI) => {
				pi.on("tool_call", async (event: ToolCallEvent) => {
					if (event.toolName !== "read") return undefined;
					const raw = (event.input as { path?: unknown } | undefined)?.path;
					if (typeof raw !== "string" || raw.length === 0) {
						return { block: true, reason: "缺少 path 参数" };
					}

					let real: string;
					try {
						real = realpathSync(resolve(raw));
					} catch {
						// 路径不存在也拦:放行等于把"文件存在吗"变成一个可探测的信道。
						return { block: true, reason: "路径不存在" };
					}

					// <runId> 在**每次调用时**展开,而不是实例化时:S3 池化后一个 session
					// 会跨多个 run,实例化时展开就会把上一个 run 的目录留给下一个 run。
					const runId = ctx.getRunId();
					const ok = roots.some((root) => {
						let realRoot: string;
						try {
							realRoot = realpathSync(resolve(root.replaceAll("<runId>", runId)));
						} catch {
							return false; // 白名单根本身不存在 ⇒ 不放行
						}
						// 必须解析符号链接后再判前缀,否则白名单内的软链可以指向任何地方。
						return real === realRoot || real.startsWith(realRoot + sep);
					});

					return ok ? undefined : { block: true, reason: "路径超出允许范围" };
				});
			},
		};
	},
};
