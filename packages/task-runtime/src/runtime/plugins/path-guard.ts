import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
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
 * 复审 C-1/I-3(2026-07-31)前,这里曾写"一旦装配层将来放开内置工具……这个 hook 会立刻
 * 对它生效,不需要改这个文件"——两处都不成立,记录下来避免再犯同一种"注释承诺了实现
 * 并不提供的保护"的错误(本项目第六次同型):
 *
 * 1. **今天这个插件是惰性的**,不是"迟早生效"。`default-plugins.ts` 只是把描述符
 *    register 进*查找表*;真正实例化要靠 spec 在 extraPlugins / approvalPolicy 等字段里
 *    显式声明(见 assembler.ts 的 specPluginRefs 拼装),只有 limits 是从 spec.limits 无条件
 *    挂载的特例。全仓目前没有任何 spec 声明 "path-guard",所以它当前不实例化、不挂
 *    tool_call、对任何 run 都不生效——这与"内置 read 工具进不来"是两回事,是更前一层的
 *    "根本没人把它接上"。
 * 2. **就算被 spec 接上,对本仓的自定义工具也不提供它看起来提供的那种保护**:本仓的自定义
 *    工具全部来自 MCP server(toolsets/mcp/adapter.ts)——另一个进程,可能是另一个 cwd、
 *    另一个文件系统视图(容器/chroot/远程文件系统)。这个插件在 task-runtime 进程里对
 *    `event.input.path` 这个*字符串*算 realpath,得到的结论只对"这个字符串在本进程的
 *    文件系统视图里指向哪里"成立;它管不了 MCP server 进程实际会把这同一个字符串解析到
 *    哪里。一个直接 `fs.readFile(input.path)` 的 MCP "read" 工具,如果两个进程的文件系统
 *    视图不一致,guard 的 ALLOW/BLOCK 判断可能与 MCP 进程实际打开的文件对不上号——这不是
 *    "以后接上就自动生效",是需要专门设计的问题。
 *
 * 因此测试直接拿 hook handler 测(见 test/path-guard.test.ts 里的假 ExtensionAPI),不去起
 * 一个真会调 `read` 的 session——这既是当前装配层的架构约束使然(`noTools:"all"` 关掉了 pi
 * 全部内置工具),也是因为"起一个真 session"验证不了第 2 点里跨进程视图这个问题本身。
 *
 * TOCTOU 是结构性的、这里修不掉:`tool_call` hook 只看得见参数字符串,拿不到已打开的
 * fd,没法把"guard 验证过的那个 fd"转交给工具去读——工具自己会重新打开一次这个路径。
 * check(这里)和 open(工具内部)之间必然有一个时间窗口,`O_NOFOLLOW` / fd 传递这条路在
 * "hook 只传字符串"的架构下不通,不是遗漏。当前不可达(`noTools:"all"` 关掉了全部内置
 * 工具,自定义工具只来自 MCP 且目前没有任何工具会写入白名单根,外部上传管线不在本仓的
 * 威胁模型内),但如果以后本仓自己起一个会写白名单根的工具,这个窗口是真实的攻击面。
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

					// I-2(2026-07-31):pi 真正的 read 工具走 resolveReadPathAsync(path, cwd),
					// 基准是 session 的 per-run 任务目录;PluginContext 没有把这个 cwd 递给插件,
					// 这里唯一能拿到的基准是本进程的 process.cwd()——两者多数时候不是同一个
					// 目录。猜错基准不是"少放行"那种安全方向的失败:是 guard 对着路径 A 算出
					// "在白名单内",工具却按它自己的基准把同一个相对字符串解析成白名单外的
					// 路径 B 去打开——方向反了。够不着 read 工具用的基准时,唯一安全的做法是
					// 只接受绝对路径,拒绝任何依赖"猜基准"才能判断的相对路径。
					if (!isAbsolute(raw)) {
						return { block: true, reason: "仅接受绝对路径" };
					}

					let real: string;
					try {
						// C-1(2026-07-31):不能先 path.resolve() 再 realpath。resolve() 是纯字符串
						// 操作,会在触碰文件系统之前就把 "linkdir/../x" 这样的片段词法折叠掉——
						// 如果 linkdir 是指向别处的符号链接,折叠掉的 ".." 会当作"就是 linkdir 的
						// 父目录",而不是"linkdir 实际指向的目录的父目录"。真正打开这个原始字符串
						// 的系统调用不会犯这个错:它会先跟随 linkdir 这个符号链接,再从符号链接
						// 指向的地方往上退一级——两者对同一个 raw 字符串给出不同的目标文件。
						// `realpathSync.native` 是对 OS realpath(3) 的直接绑定,逐段展开符号链接、
						// 按展开后的实际目录处理 ".."(不经过 JS 那层会先做 path.resolve() 词法
						// 折叠的 `realpathSync` 包装),因此必须直接喂原始字符串给它,两处都不能
						// 再包一层 resolve()——包了等于白折腾,折叠已经在 resolve() 那一步发生过
						// 了,realpath 那时已经看不见原来的符号链接片段。
						real = realpathSync.native(raw);
					} catch {
						// 路径不存在也拦:放行等于把"文件存在吗"变成一个可探测的信道。
						// 副作用(记录,不是缺陷):pi 的 read 工具在路径不存在时会尝试 NFD /
						// 弯引号 / AM-PM 等变体回退再找一次(path-utils.ts),但那些回退只在
						// "解析出来的路径不存在"时才触发——guard 在这一步已经拦下了,回退永远
						// 没有机会跑。
						return { block: true, reason: "路径不存在" };
					}

					// <runId> 在**每次调用时**展开,而不是实例化时:S3 池化后一个 session
					// 会跨多个 run,实例化时展开就会把上一个 run 的目录留给下一个 run。
					const runId = ctx.getRunId();
					const ok = roots.some((root) => {
						let realRoot: string;
						try {
							// M-3(记录,不用改):这里假定 runId 本身是路径安全 token,不含 "../"
							// 之类会改写白名单根的片段——目前成立,run-manager.ts 的默认
							// newRunId 是 randomUUID();但 newRunId 是可注入选项,如果将来换成
							// 客户端可影响的 id,这里不会拦一个把 "uploads/<runId>" 改写成
							// "/etc" 的恶意 runId。
							realRoot = realpathSync.native(root.replaceAll("<runId>", runId));
						} catch {
							return false; // 白名单根本身不存在 ⇒ 不放行
						}
						// 必须解析符号链接后再判前缀,否则白名单内的软链可以指向任何地方。
						// macOS 上 realpath 不归一化大小写(实测):大小写变体会被精确字符串比较
						// 拦下,方向是安全的(拦了本该放行的合法大小写变体,不是放行了本该拦的
						// 路径),但如果调用方真的传入合法的大小写变体路径,会被这里误判成
						// "路径超出允许范围"而不是更准确的"大小写不匹配"。
						return real === realRoot || real.startsWith(realRoot + sep);
					});

					return ok ? undefined : { block: true, reason: "路径超出允许范围" };
				});
			},
		};
	},
};
