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
 *    那处判断)。**这条应对的理由不是"没有 `..` 时词法折叠是恒等变换"——那句字面为假**,
 *    这里曾经就是那么写的(2026-07-31 全分支审查 C-1 订正,本项目第十次"局部观察 → 机制
 *    断言"):`path.resolve` 即使不含 `..` 也仍会删 `.` 段、合并重复分隔符、剥掉尾部分隔符,
 *    实测 `/a/./b`、`/a//b`、`/a/b/`、`//a/b`、`/a/b/.`、`/a/` 六种输入**无一是恒等**。
 *    正确的理由是:剩下这三种残余变换都是**目标保持**的——它们只可能让 `ENOTDIR` 之类的
 *    错误消失(即偏向过度拦截的方向),**不改变 `open()` 最终到达的 inode**。目标保持是比
 *    恒等更弱、但正是本条论证所需要的性质;第 3 点的"死代码"结论也架在它上面。
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
 *    (`\p{Cc}`)。中文文件名不受影响(中文字符属于 Unicode 的"Letter, other"类,不落在
 *    White_Space/Cf/Cc 里)。**但 `\p{Cf}` 不是一个没有代价的选择,如实列出已知会被误伤的
 *    合法用法**:emoji 的 ZWJ 组合序列(如 👨‍👩‍👧、🏳️‍🌈,连接用的 U+200D 零宽连接符属于
 *    Cf)会被拆散;波斯语、印地语等使用天城文的书写系统里,U+200C 零宽非连接符是正字法
 *    必需的一部分,不是可有可无的格式修饰,含这个字符的合法文件名会被拒绝;U+00AD 软连字符、
 *    U+061C 阿拉伯字母标记也可能出现在正常文本里。本系统是中文审计场景,合法文件名以
 *    中文/英文/数字为主,这里接受这个代价;如果将来上传文件名可能来自波斯语/印地语用户
 *    或含 emoji ZWJ 序列,这条规则会造成真实误伤,需要单独评估是否把 `\p{Cf}` 收窄成
 *    "已知参与上面这类攻击的具体字符"而不是整类拒绝。
 * 3. **仅在"解析出来的路径不存在"时才触发的变体回退(已知缺口,封闭性寄生在第 1、2 条
 *    和下面 catch 分支那条存在性检查上,不是它自己天生无害)**:`path-utils.ts` 的
 *    `resolveReadPathAsync` 在第 2 点的归一化+折叠都做完之后,如果结果路径在磁盘上找不到,
 *    还会依次尝试 4 种变体再找一次:macOS 截图文件名的 AM/PM 窄空格替换、NFD(macOS 常见
 *    的分解式 Unicode 归一化)、弯引号替换(`'`→`'`)、NFD+弯引号组合。复审用真实 guard +
 *    真实 `resolveReadPathAsync` 搭了 11 个向量实测(NFD/NFC 孪生正反两向、弯引号孪生
 *    正反两向、AM/PM 窄空格、`path.resolve` 变形),0 exploit,同时给出了决定性反例:
 *    白名单内放一个用普通空格命名、且不存在对应 AM/PM 窄空格变体的名字时,pi 的 AM/PM
 *    回退**确实**解析到了白名单外并读出了越权内容——单独看"这条回退链"完全不是无害的,
 *    它只是在"guard 会放行的输入"这个子集上凑巧从不触发。挡住它的机制是:
 *    `resolveReadPathAsync` 的回退唯一入口是 `!pathExists(resolved)`,而 guard 放行的
 *    前提是 `realpathSync.native(raw)` 成功(即 `raw` 存在)——第 2 点的归一化两边都做过、
 *    第 1 点又拒掉了含 `..` 的路径,而剩下的那些词法变换是**目标保持**的(见第 1 点:它们
 *    不是恒等变换,但不改变 `open()` 到达的 inode,因而也不改变"这个路径存在与否"这个
 *    判断),所以 guard 与 pi 在"是否存在"这一步看到的其实是同一个判断:`resolved` 存在
 *    ⇔ `raw` 存在,回退分支的触发条件("resolved 不存在")对任何被 guard 放行的输入恒为
 *    假——回退代码对 guard 放行的路径是死代码。
 *    **这个"死代码"结论寄生在第 1、2 条规则 + 下面 catch 分支的"路径不存在也拦"这三者
 *    之上,三者中任何一个被将来的改动削弱(比如放宽存在性检查、允许读尚未生成的文件),
 *    这条回退链会立刻重新变成活代码、可被利用**——这是一个已知、尚未独立关闭的分歧来源,
 *    如果将来要不依赖第 1/2 条和存在性检查、独立收紧它,需要针对 NFD/弯引号这两种具体
 *    变换分别设计(不能像第 2 点那样简单地"拒绝一整类字符"了事,因为可组合重音的拉丁
 *    字母、部分标点在合法文件名里并不罕见,不能整体拒绝)。
 * 4. **本文件注释与测试引用的源码版本,不等于 task-runtime 实际加载的版本(已知、未锁定)**:
 *    上面几点的分析基于 `packages/coding-agent/src/utils/paths.ts` / `path-utils.ts`
 *    (仓库根 workspace 版本,0.83.0);但 `packages/task-runtime/package.json` 声明的
 *    依赖是 `^0.82.1`,不接受 0.83.0,`packages/task-runtime/node_modules/
 *    @earendil-works/pi-coding-agent` 下装的是**注册表实装的 0.82.1**,不是指向
 *    `packages/coding-agent` 的软链(根 node_modules 下那个软链才是 0.83.0)——
 *    task-runtime 进程(包括 test/path-guard.test.ts 里用来做端到端验证的那份)实际跑的
 *    是 0.82.1 的编译产物。已逐行比对过 0.82.1 与 0.83.0 的 `UNICODE_SPACES` 正则和
 *    `resolveReadPathAsync` 的四路回退链——**今天两者完全一致**,上面的分析对两个版本
 *    同时成立,但**没有任何机制锁定这一点**:task-runtime 升到 `^0.83.0`(或注册表推出
 *    新的 0.82.x 补丁版本)且 pi 那边改了这两处实现,这里不会有任何提示。"读的那份源码
 *    ≠ 真正加载的那份"正是催生 NC-1/NC-3 两条 Critical 的同一类风险(guard 的假设和
 *    消费方的真实行为脱节)——这里只是记在案,没有关闭它。
 * 5. **guard 校验的那个字符串,可能根本不是消费方拿到的那个(已知缺口,与前四条性质不同)**:
 *    前四条都是"guard 与消费方对**同一个字符串**的解释不同";这一条是那个字符串本身在
 *    guard 判完之后被改掉。pi 的 `ToolCallEventResult` 明写
 *    `/** Block tool execution. To modify arguments, mutate 'event.input' in place instead. *\/`
 *    ——**原地改写 `event.input` 是 pi 官方推荐的改参方式**,而本 hook 校验的正是
 *    `event.input.path`。任何排在 path-guard **之后**的 `tool_call` handler 只要原地改写
 *    该字段,guard 放行的就是旧值、工具打开的是新值,构成**完整绕过**(不是语义分歧,是
 *    校验对象被掉包)。更麻烦的是装配期冲突校验拦不住它:`plugin-registry.ts` 的
 *    `REPLACING_HOOKS` **不含 `tool_call`**(它被当作可叠加的观察型 hook),所以第二个声明
 *    `tool_call` 的插件可以和 path-guard 同时挂上、不报冲突,顺序也无人约束。
 *    **今天不可达**:全仓只有本插件挂 `tool_call`,而本插件自己还是惰性的(见上面第 1 段)。
 *    **应对:无** —— 这里只是按本文件的规矩把它登记进清单,不是已关闭。将来若出现第二个
 *    `tool_call` 插件,要么把 `tool_call` 归进 `REPLACING_HOOKS`,要么让 guard 在 hook 链
 *    末尾复查一次它当初批准的那个字符串是否仍然是 `event.input.path` 的当前值。
 *
 * 这份清单只覆盖"已经被复审用真实向量证明过分歧"的两类(第 1、2 点),和三类记录在案但
 * 未独立关闭的已知缺口(第 3、4、5 点)。**消费方新增一种字符串变换,这里不会自动感知**——
 * 这不是"猜不到就不用防"的借口,而是这个防线的真实边界:任何人往这个文件加新的拒绝规则
 * 之前,应该先在这里补一条对应的分歧来源说明,而不是删掉旧的再加一条新的。
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
					// 控制符的路径会被拒绝。中文/英文/数字文件名不受影响,但 emoji ZWJ 组合
					// 序列(U+200D)与波斯语/印地语正字法必需的 ZWNJ(U+200C)会被误伤——
					// 本系统是中文审计场景,这里接受这个代价;详见文件顶部清单第 2 条。
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
						// 这一条同时是文件顶部"分歧来源"清单第 3 条(仅在解析不到时才触发的
						// NFD/弯引号/AM-PM 变体回退)之所以对 guard 放行的输入是死代码的
						// **唯一封条**——连同上面第 1、2 条(拒绝 ".." 段、拒绝危险 Unicode
						// 字符)一起,三者共同保证"guard 放行 ⇒ raw 存在 ⇒ pi 那边的
						// !pathExists(resolved) 恒为假、回退分支根本不会跑"。这条判断一旦被
						// 放宽(比如为了给出更友好的错误提示,或允许读尚未生成的文件),第 3
						// 条那整条回退链会立刻从死代码变回可利用的攻击面,不是这里顺手写的
						// 防御纵深,是清单第 3 条封闭性的必要前提。
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
