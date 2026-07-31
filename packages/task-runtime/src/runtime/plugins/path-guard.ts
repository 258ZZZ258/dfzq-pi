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

/** 见文件顶部"guard 与消费方的分歧来源"清单——目前枚举到的三类都在这里判。 */
const DANGEROUS_UNICODE_CHAR = /(?!\x20)[\p{White_Space}\p{Cf}\p{Cc}]/u;

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
 * **guard 与"消费方最终怎么解析这同一个字符串"之间的分歧来源(2026-07-31,复审 NC-1/NC-3
 * 之后收窄措辞——不再断言"不存在分歧"或"消费方语义不再重要",那两句都被证伪过一次)。**
 *
 * guard 在 task-runtime 进程里对 `event.input.path` 这个字符串自己算 realpath;真正打开
 * 文件的是别的代码(pi 自己的 `read` 工具,或将来某个自定义工具)。guard 的判定只有在它对
 * 这个字符串的解释与消费方一致时才有意义——下面是**目前已知**会让两者对同一个字符串给出
 * 不同目标文件的分歧来源,以及本文件对每一条采取的应对。这是一份维护中的清单,不是一个
 * 已证明穷尽的集合:
 *
 * 1. **词法折叠 vs 符号链接感知解析(NC-1)**:pi 的 `read` 走
 *    `packages/coding-agent/src/utils/paths.ts` 的 `resolvePath` → `nodeResolvePath`
 *    (即 `path.resolve`)——**先**对字符串做纯词法折叠(`..` 按字符串位置抵消,不看任何
 *    一段是不是符号链接),**再**拿折叠后的字符串去 open。`realpathSync.native` 则相反:
 *    跟随符号链接、按展开后的实际目录处理 `..`。路径含 `..` 且中间穿过一个符号链接目录时,
 *    两者会给出不同的目标文件。**应对**:拒绝任何含 `..` 段的绝对路径(下面 `.split(sep)`
 *    那处判断)——没有 `..` 时词法折叠是恒等变换,两种解析对同一个前缀必然一致。
 * 2. **Unicode 空白/格式/控制字符归一化(NC-3)**:`path-utils.ts` 的 `resolveToCwd` 在
 *    折叠 `..` **之前**,先把输入过一遍 `paths.ts` 的 `normalizePath`
 *    (`{ normalizeUnicodeSpaces: true }`),把 U+00A0 / U+2000-200A / U+202F / U+205F /
 *    U+3000 等"看起来像空格"的字符统一替换成普通空格 U+0020,且**这一步无条件发生**,不像
 *    下面第 3 点那样只在"解析出来的路径不存在"时才触发。若白名单内存在一个用其中某个
 *    "貌似空格"字符命名的真实条目,同时紧邻着一个用普通空格命名、指向白名单外的符号链接,
 *    guard 对原始字符串算出的 realpath(落在白名单内的真实条目上)与 pi 对"归一化后的
 *    字符串"算出的目标(落在符号链接指向的白名单外)是两个不同的文件。**应对**:拒绝任何
 *    命中 `DANGEROUS_UNICODE_CHAR` 的路径(下面判断)。**这里没有去复刻 `normalizePath`
 *    的具体替换表**(那样等于把"猜消费方今天长什么样"焊进代码,消费方明天加一个新变体
 *    这里就要跟着改)——而是拒绝一个更宽的类别:除普通 ASCII 空格外的全部 Unicode 空白
 *    (`\p{White_Space}`,涵盖 pi 现在处理的 15 个字符,以及 tab/换行等)、全部格式字符
 *    (`\p{Cf}`:零宽空格/连接符、BOM、双向文本控制符等"看不见"的字符)、全部控制字符
 *    (`\p{Cc}`)。选更宽类别而不是逐字抄 pi 的正则表,是因为这三类字符**在合法文件名里
 *    本来就几乎不出现**(包括中文文件名——本系统是中文审计系统,合法文件名大量含中文,
 *    但中文字符属于 Unicode 的"Letter, other"类,不落在 White_Space/Cf/Cc 里,不受影响),
 *    拦下来的实际代价接近零,同时不需要精确复刻任何一个消费方的替换表就能覆盖"用不可见/
 *    看似等价的字符做白名单内投放"这整个攻击家族,不止 pi 今天用到的这几个字符。
 * 3. **仅在"解析出来的路径不存在"时才触发的变体回退(已知、本轮未关闭)**:
 *    `path-utils.ts` 的 `resolveReadPathAsync` 在第 2 点的归一化+折叠都做完之后,如果
 *    结果路径在磁盘上找不到,还会依次尝试 4 种变体再找一次:macOS 截图文件名的
 *    AM/PM 窄空格替换、NFD(macOS 常见的分解式 Unicode 归一化)、弯引号替换(`'`→`'`)、
 *    NFD+弯引号组合。这些回退**不是无条件的**——只有 guard 判定用的原始字符串本身解析
 *    不到任何东西时才可能触发,而 guard 对"解析不到"是直接拒绝的(见下面 catch 分支),
 *    所以第 2 点那种"guard 与消费方对同一字符串都能成功解析、但解析到不同文件"的攻击
 *    形态在这里不成立;但如果以后攻击者能构造"guard 用原始字符串解析到白名单内的某个
 *    真实文件 A(不触发回退),而 pi 因为某种原因(比如磁盘用不同的 Unicode 正规化形式
 *    存储文件名)对同一个已归一化字符串解析到白名单外的文件 B(也不触发回退,直接命中)",
 *    这条路径仍然不受本文件保护——**这是一个已知、尚未关闭的分歧来源,不是本文件覆盖到的
 *    第三种情形**,如果将来要收紧,需要针对 NFD/弯引号这两种具体变换分别设计(不能像第 2
 *    点那样简单地"拒绝一整类字符"了事,因为可组合重音的拉丁字母、部分标点在合法文件名里
 *    并不罕见,不能整体拒绝)。
 *
 * 这份清单只覆盖"已经被复审用真实向量证明过分歧"的两类(第 1、2 点),和一类记录在案但
 * 未关闭的已知缺口(第 3 点)。**消费方新增一种字符串变换,这里不会自动感知**——这不是
 * "猜不到就不用防"的借口,而是这个防线的真实边界:任何人往这个文件加新的拒绝规则之前,
 * 应该先在这里补一条对应的分歧来源说明,而不是删掉旧的再加一条新的。
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

					// NC-1(2026-07-31):见文件顶部"分歧来源"清单第 1 条。含 `..` 段时,
					// "词法折叠后 open"与"跟随符号链接后对实际目录算 .."这两种解析语义会给出
					// 不同的目标文件。**代价**:白名单内本来合法的写法(比如
					// `<allowRoot>/sub/../ok.txt`,单纯回到同目录再进入)也会被这条规则拒绝——
					// 这是功能限制,不是安全漏洞:调用方总能改用不含 `..` 的等价绝对路径表达
					// 同一个目标,guard 拒绝的是"这种表达方式",不是"能不能读到这个文件"。
					if (raw.split(sep).includes("..")) {
						return { block: true, reason: "路径包含 .. 段" };
					}

					// NC-3(2026-07-31):见文件顶部"分歧来源"清单第 2 条。guard 不做 pi 那种
					// Unicode 空白归一化,若白名单内有一个用"貌似空格"字符命名的真实条目、
					// 旁边有个用普通空格命名指向白名单外的符号链接,guard 和 pi 会对同一个
					// 原始字符串解析到不同的文件。**代价**:文件名含制表符/零宽字符/双向文本
					// 控制符等的路径会被拒绝——这类字符在合法文件名里(包括中文文件名)本来就
					// 不该出现,拦下来的实际代价接近零。
					if (DANGEROUS_UNICODE_CHAR.test(raw)) {
						return { block: true, reason: "路径包含不可见或需要归一化的字符" };
					}

					let real: string;
					try {
						// 上面已经拒绝了含 ".." 与危险 Unicode 字符的路径,不会再撞见清单第 1、2
						// 条那两种分歧(清单第 3 条——只在"解析不到"时才触发的变体回退——不在
						// 这里关闭,见文件顶部说明)。`realpathSync.native` 在这个前提下只需要
						// 再解析路径末端可能存在的符号链接(文件/目录本身是软链,但路径中间没有
						// ".." 跟在软链后面的情形),就是本插件存在的理由:不解析符号链接就判
						// 前缀,等于把白名单让给了软链。
						real = realpathSync.native(raw);
					} catch {
						// 路径不存在也拦:放行等于把"文件存在吗"变成一个可探测的信道。
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
							// "/etc" 的恶意 runId(何况 `<runId>` 展开发生在上面两道输入侧校验
							// *之后*——那两道校验只看得见调用方传入的 `raw`,看不见 runId 展开后
							// 的白名单根里有没有 ".." 或危险字符)。
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
