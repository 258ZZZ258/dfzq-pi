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
 *    哪里。这不是"以后接上就自动生效",是需要专门设计的问题。
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
 *
 * **NC-1(2026-07-31):guard 不知道最终消费方按哪种语义解析 `..`,所以不能只挑一种去猜。**
 * 上一轮把 C-1 的修法定成"realpath 前不能先 resolve()",隐含假设是"消费方会把原始字符串
 * 直接交给 open(2)"(那样才会先跟随符号链接、再对展开后的实际目录计算 `..`)。但 pi 自己的
 * `read` 工具走的是相反的语义(`packages/coding-agent/src/utils/paths.ts` 的
 * `resolveReadPathAsync` → `nodeResolvePath` 就是 `path.resolve`):**先**对字符串做纯词法
 * 折叠(`..` 按字符串位置抵消,不看任何一段是不是符号链接),**再**拿折叠后的字符串去 open。
 * 这两种语义在"路径含 `..` 且中间穿过一个符号链接目录"时会给出两个不同的目标文件——挑
 * 哪一种做 realpath 判定,都只覆盖一半消费方、对另一半是新的绕过(比如一个软链指向白名单
 * *内部*深处、后面跟 `..` 靠词法折叠逃到白名单外——`realpathSync.native` 会跟随符号链接把
 * 它判成"还在白名单内",而 pi 的 `read` 实际词法折叠出来的路径早就在白名单外了)。
 *
 * 两种语义唯一保证收敛的情况是**路径里根本没有 `..`**:没有 `..` 时词法折叠是恒等变换,
 * 符号链接感知的解析与词法解析对同一个前缀给出同一个答案(最终段是不是符号链接不影响这个
 * 结论,只有中间的 `..` 段才会让"折叠"和"先跟随再退一级"分道扬镳)。所以除了"必须绝对
 * 路径"(I-2)之外,还必须拒绝任何含 `..` 段的路径——这不是"防哪种消费方"的选择题,是让
 * 消费方是哪种语义这件事变得不再重要。
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

					// NC-1(2026-07-31):见文件顶部注释。含 `..` 段时,"词法折叠后 open"与
					// "跟随符号链接后对实际目录算 .."这两种消费方语义会给出不同的目标文件,
					// guard 猜不出消费方是哪一种,唯一不产生新绕过的做法是直接拒绝。
					if (raw.split(sep).includes("..")) {
						return { block: true, reason: "路径包含 .. 段" };
					}

					let real: string;
					try {
						// 上面已经拒绝了所有含 ".." 的路径,这里不会再有"词法折叠 vs 符号链接
						// 感知"的语义分歧——`realpathSync.native` 只需要再解析路径末端可能存在的
						// 符号链接(文件/目录本身是软链,但路径中间没有 ".." 跟在软链后面的情形),
						// 就是本插件存在的理由:不解析符号链接就判前缀,等于把白名单让给了软链。
						real = realpathSync.native(raw);
					} catch {
						// 路径不存在也拦:放行等于把"文件存在吗"变成一个可探测的信道。
						// 副作用(记录,不是缺陷):pi 的 read 工具在"guard 与它对同一个原始
						// 字符串算出同一个目标路径"时,若该路径不存在会尝试 NFD / 弯引号 /
						// AM-PM 等变体回退再找一次(path-utils.ts)——guard 在这一步已经拦下,
						// 回退没有机会跑。但这个限定是必要的:上面 NC-1 提到的语义分歧场景下,
						// guard 判定用的路径和 pi 实际打开的路径本就不是同一个字符串,"回退跑不
						// 跑"要看 pi 那边实际解析出来的路径是否存在,与 guard 这里的存在性判断
						// 无关——本节点已经把这类含 ".." 的输入整体拒绝,不会走到这里。
						return { block: true, reason: "路径不存在" };
					}

					// <runId> 在**每次调用时**展开,而不是实例化时:S3 池化后一个 session
					// 会跨多个 run,实例化时展开就会把上一个 run 的目录留给下一个 run。
					const runId = ctx.getRunId();
					const ok = roots.some((root) => {
						const expandedRoot = root.replaceAll("<runId>", runId);
						// 与输入侧(I-2)对称:根本身也必须是绝对路径。这里的 root 来自装配
						// 期的插件配置(受信任),不是 event.input 那种攻击面,但如果写成相对
						// 路径,`realpathSync.native` 会按本进程 process.cwd() 展开——同样是
						// "猜一个可能与消费方基准不一致的路径",不放行比猜更安全。
						if (!isAbsolute(expandedRoot)) return false;
						let realRoot: string;
						try {
							// M-3(记录,不用改):这里假定 runId 本身是路径安全 token,不含 "../"
							// 之类会改写白名单根的片段——目前成立,src/server/run-manager.ts 的
							// 默认 newRunId 是 randomUUID();但 newRunId 是可注入选项,如果将来
							// 换成客户端可影响的 id,这里不会拦一个把 "uploads/<runId>" 改写成
							// "/etc" 的恶意 runId(何况 `<runId>` 展开发生在上面的 ".." 段校验
							// *之后*——那道校验只看得见调用方传入的 `raw`,看不见 runId 展开后
							// 的白名单根里有没有 "..")。
							realRoot = realpathSync.native(expandedRoot);
						} catch {
							return false; // 白名单根本身不存在 ⇒ 不放行
						}
						// 前缀判定不能用裸 startsWith(见下面 sep 拼接),否则
						// "/allow-evil" 会被 "/allow" 放行。
						//
						// 大小写(不)敏感是**卷**的属性,不是 OS 的属性,这里不对"某平台默认
						// 行为"下机制断言(复审 NC-2 指出上一版这里的"macOS 上 realpath 不
						// 归一化大小写"是切到 `.native` 之前对旧 `realpathSync` 的实测结论,
						// 换了实现没有重测就留了下来——已用 `.native` 重新实测:默认大小写不
						// 敏感卷上,`realpathSync.native` **会**把大小写变体归一化成磁盘上的
						// 规范大小写)。由于路径侧和根侧现在都统一经过 `realpathSync.native`,
						// 两边在同一个卷上会被同一套规则折叠,比较依旧自洽,不构成越权;但
						// 具体是否折叠、怎么折叠,因卷而异,不在此处断言全局结论。
						return real === realRoot || real.startsWith(realRoot + sep);
					});

					return ok ? undefined : { block: true, reason: "路径超出允许范围" };
				});
			},
		};
	},
};
