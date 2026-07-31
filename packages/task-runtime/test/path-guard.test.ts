import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { pathGuardDescriptor } from "../src/runtime/plugins/path-guard.ts";

/**
 * 复审 NC-3(2026-07-31)明确要求:这条缺陷的本质是"guard 自己看着没问题",所以测试不能
 * 只测 guard 自己的返回值,必须拿 pi **真实的** `resolveReadPathAsync` 做端到端断言。这个
 * 函数没有出现在 `@earendil-works/pi-coding-agent` 的公开 `exports`(package.json 只导出
 * `.` 和 `./rpc-entry`),没法用普通的包名 import。
 *
 * 用 `import.meta.resolve()` 先拿到这个包**真正会被 task-runtime 加载的那份入口**——走
 * 与生产代码 `import "@earendil-works/pi-coding-agent"` 同一条 Node ESM 解析路径,不用
 * 假设"这个包没有被提升到仓库根 node_modules"(复审发现的版本分叉正是这类假设会踩的坑:
 * `packages/task-runtime` 依赖 `^0.82.1`,解析到的是它自己 node_modules 下注册表实装的
 * 0.82.1,不是根 node_modules 那个指向 `packages/coding-agent`、版本是 0.83.0 的软链——
 * `import.meta.resolve` 不管包实际装在哪一层,给出的都是 task-runtime 自己会加载的那份)。
 * 从入口(`dist/index.js`)推算包目录、再拼接到内部没有公开导出的
 * `dist/core/tools/path-utils.js`——这一段仍然是"押注 dist 内部目录布局不变",没有更好的
 * 办法(pi 没把 `resolveReadPathAsync` 放进公开 exports)。这个押注不会静默错:布局一旦
 * 漂移,`import()` 会直接 `ERR_MODULE_NOT_FOUND` 硬失败,不是悄悄导入到别的东西、让测试
 * 继续假装在验证真实行为。
 *
 * **用一个拼出来的、非字符串字面量的 specifier 传给 `import()`,不是图省事**:仓库根
 * `npm run check` 里的 `check:ts-imports`(scripts/check-ts-relative-imports.mjs)用
 * `typescript` 的 `ts.createSourceFile` 走 **AST**(不是字符串匹配),只检查
 * `ImportDeclaration` / `ExportDeclaration` / 动态 `import()` 调用 / `ImportTypeNode`
 * 上**是字符串字面量**的 specifier 是否以 `.js` 结尾的相对路径——它的检查范围本来就不含
 * "非字面量的 import 参数",不是"認不出"字面量和计算表达式的区别、被绕过去了,而是它压根
 * 没打算检查计算表达式(那条规则的本意是防止本仓自己的源码文件互相用 .js 扩展名 import,
 * 相对路径 + 字面量 + .js 结尾是这类误用唯一会出现的形态)。这条耦合本身是脆的:pi 升级、
 * 把这几个内部文件挪了地方,这个测试会跟着炸——这是"直接验证真实消费方行为"和"耦合到
 * 未公开的内部实现"这对权衡下,复审明确要的那一侧。
 */
async function loadPiReadPathResolver(): Promise<{
	resolveReadPathAsync: (filePath: string, cwd: string) => Promise<string>;
}> {
	const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const packageRoot = dirname(dirname(fileURLToPath(entryUrl))); // 剥掉 "dist/index.js"
	const target = join(packageRoot, "dist", "core", "tools", "path-utils.js");
	return (await import(pathToFileURL(target).href)) as {
		resolveReadPathAsync: (filePath: string, cwd: string) => Promise<string>;
	};
}

let root: string;
let allowed: string;
let outside: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-guard-"));
	allowed = join(root, "uploads", "run-1");
	outside = join(root, "secrets");
	await mkdir(allowed, { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(allowed, "ok.txt"), "ok");
	await writeFile(join(outside, "secret.txt"), "secret");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function instantiate(allowRoots: string[], runId = "run-1") {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	const ctx: PluginContext = {
		specId: "s1",
		getRunId: () => runId,
		getRunInput: () => "",
		getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
		abort: () => {},
		limitState: { turns: 0 },
		registerFinalJudge: () => {},
	};
	const extension = pathGuardDescriptor.factory(ctx, { allowRoots });
	const factory = typeof extension === "function" ? extension : extension.factory;
	(factory as (api: unknown) => void)({
		on: (_type: string, h: (event: unknown) => Promise<unknown>) => {
			handler = h;
		},
	});
	return handler!;
}

describe("path-guard", () => {
	it("claims the tool_call hook and is registered by default", () => {
		expect(pathGuardDescriptor.hooks).toEqual(["tool_call"]);
		expect(createDefaultPluginRegistry().has("path-guard")).toBe(true);
	});

	it("ignores tools other than read", async () => {
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "search_policy", input: {} })).toBeUndefined();
	});

	it("allows a file inside an allowed root", async () => {
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: { path: join(allowed, "ok.txt") } })).toBeUndefined();
	});

	it("blocks a file outside every allowed root", async () => {
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: { path: join(outside, "secret.txt") } })).toMatchObject({
			block: true,
		});
	});

	it("blocks a sibling root whose name merely shares a string prefix (no separator boundary)", async () => {
		// 判别性验证:前缀判定若用裸 `startsWith(realRoot)`,`.../uploads/run-1-evil` 会被
		// `.../uploads/run-1` 放行 —— 必须用 `real === realRoot || real.startsWith(realRoot + sep)`。
		const evilSibling = join(root, "uploads", "run-1-evil");
		await mkdir(evilSibling, { recursive: true });
		await writeFile(join(evilSibling, "leak.txt"), "leak");
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: { path: join(evilSibling, "leak.txt") } })).toMatchObject({
			block: true,
		});
	});

	it("blocks a symlink inside an allowed root that escapes to the outside", async () => {
		// 这是本插件存在的理由:不解析符号链接就判前缀,等于把白名单让给了软链。
		await symlink(join(outside, "secret.txt"), join(allowed, "escape.txt"));
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: { path: join(allowed, "escape.txt") } })).toMatchObject({
			block: true,
		});
	});

	it("blocks a `..` traversal through a symlinked directory pointing outside (C-1)", async () => {
		// 判别性验证(复审 C-1,2026-07-31,措辞按复审 NC-1 附带意见收窄):linkdir 指向白名单
		// 外的 outside 目录。若某个消费方直接把这个原始字符串交给 open(2)(比如一个直接
		// `fs.readFile(input.path)` 的 MCP 工具,不做任何词法折叠),它会先跟随 linkdir 这个
		// 符号链接、再从它指向的地方往上退一级(落到 root,不是 allowed 的父目录),读到
		// root/ok.txt(白名单外)——这个说法**不对 pi 自己的 read 工具成立**:pi 会先对字符串
		// 做词法折叠(path.resolve,不看 linkdir 是不是符号链接),折叠结果落回
		// allowed/ok.txt(白名单**内**),读到的是合法的 ok.txt,不是外面那份。
		// 现在的判定不再依赖"猜哪种消费方语义":本插件对任何含 ".." 段的路径一律拒绝
		// (NC-1),这里手工拼接 raw、不经过 `join()`(`join()` 内部会 normalize 掉 ".."),
		// 才能保留原始的 "linkdir/.." 片段来验证这条拒绝规则本身生效。
		await symlink(outside, join(allowed, "linkdir"));
		await writeFile(join(root, "ok.txt"), "PWNED-OUTSIDE"); // 与 allowed 同级,白名单外
		const handler = instantiate([allowed]);
		const raw = `${allowed}${sep}linkdir${sep}..${sep}ok.txt`;
		expect(await handler({ toolName: "read", input: { path: raw } })).toMatchObject({ block: true });
	});

	it("blocks a `..` traversal through a symlink that points *inside* the allowed root (NC-1: mirror of C-1)", async () => {
		// 判别性验证(复审 NC-1,2026-07-31):link 指向白名单**内部**深处(allowed/a/b),不是
		// 外部。跟随符号链接、按展开后的实际目录处理 ".." 的解析(即 C-1 修复后 guard 用的
		// realpathSync.native)会把这条 raw 判成"还在 allowed 内"(ALLOW)——但 pi 自己的
		// read 工具先对字符串做纯词法折叠(path.resolve,不看 link 是不是符号链接)再 open:
		// 折叠 "run-1/link/../../ok.txt" 时,"link" 和紧跟的第一个 ".." 相互抵消、"run-1" 和
		// 第二个 ".." 相互抵消,落到 "uploads/ok.txt"——在 allowed 的父目录,白名单**外**。
		// 同一个 raw 字符串,两种解析语义给出两个不同的目标文件:只做符号链接感知的
		// realpath 比较(上一轮 C-1 的修法)会在这条向量上 ALLOW。必须靠"拒绝任何含 .. 的
		// 路径"这条更前置的规则才能两头都不漏——这条测试就是在锁这条规则本身,而不是锁某一种
		// realpath 实现。
		await mkdir(join(allowed, "a", "b"), { recursive: true });
		await symlink(join(allowed, "a", "b"), join(allowed, "link"));
		await writeFile(join(root, "uploads", "ok.txt"), "PWNED-OUTSIDE"); // allowed 的父目录,白名单外
		const handler = instantiate([allowed]);
		const raw = `${allowed}${sep}link${sep}..${sep}..${sep}ok.txt`;
		expect(await handler({ toolName: "read", input: { path: raw } })).toMatchObject({ block: true });
	});

	it("blocks a Unicode-space twin-name escape that pi's real resolveReadPathAsync resolves outside the allowed root (NC-3)", async () => {
		// 端到端判别性验证(复审 NC-3,2026-07-31)。向量:白名单内放一个用"貌似空格"字符
		// (NBSP,U+00A0)命名的真实目录,旁边放一个用普通空格命名、指向白名单外的符号链接。
		// pi 的 resolveToCwd 在解析之前会无条件把 NBSP 之类的 Unicode 空格替换成普通空格
		// (paths.ts 的 normalizePath),guard 不做这件事——guard 对原始字符串(含 NBSP)算出
		// 的 realpath 落在白名单内的真实目录上,pi 对"替换后的字符串"(含普通空格)算出的
		// 目标却是那个符号链接指向的白名单外文件。
		const nbsp = String.fromCharCode(0xa0); // U+00A0 NO-BREAK SPACE,显式写码点,不在源码里放不可见字节
		const realDirName = `a${nbsp}b`; // 白名单内的真实目录,用 NBSP 命名
		const twinDirName = "a b"; // 普通空格版本——pi 归一化后实际会打开的名字
		await mkdir(join(allowed, realDirName), { recursive: true });
		await writeFile(join(allowed, realDirName, "ok.txt"), "ok");
		await symlink(outside, join(allowed, twinDirName)); // 普通空格版本是指向白名单外的符号链接
		await writeFile(join(outside, "ok.txt"), "PWNED-OUTSIDE");

		const raw = join(allowed, realDirName, "ok.txt");
		const realAllowed = realpathSync.native(allowed);

		// "guard 自己看着没问题"的那一半:不加 NC-3 这道校验,guard 对原始字符串(含 NBSP)
		// 算出的 realpath 确确实实落在白名单内——这不是假设,是直接调同一个 realpathSync.native
		// 验证。
		const naiveGuardRealpath = realpathSync.native(raw);
		expect(naiveGuardRealpath === realAllowed || naiveGuardRealpath.startsWith(realAllowed + sep)).toBe(true);

		// 端到端的另一半:pi 真实的 resolveReadPathAsync 对同一个原始字符串,解析到的是
		// 白名单外的文件——这才是本条缺陷"实际会读到什么"的证据,不是猜测。
		const { resolveReadPathAsync } = await loadPiReadPathResolver();
		const piResolved = await resolveReadPathAsync(raw, root);
		const piReal = realpathSync.native(piResolved);
		expect(piReal === realAllowed || piReal.startsWith(realAllowed + sep)).toBe(false);

		// guard 现在必须拦这个原始字符串,而不是像上面 naiveGuardRealpath 展示的那样放行。
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: { path: raw } })).toMatchObject({ block: true });
	});

	it("blocks a missing path instead of letting it through", async () => {
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: { path: join(allowed, "nope.txt") } })).toMatchObject({
			block: true,
		});
	});

	it("blocks a call with no path argument", async () => {
		const handler = instantiate([allowed]);
		expect(await handler({ toolName: "read", input: {} })).toMatchObject({ block: true });
	});

	it("blocks a relative path even when it happens to resolve inside an allowed root by process.cwd() (I-2)", async () => {
		// 判别性验证(复审 I-2,2026-07-31):真正的 read 工具按 session 的 per-run 任务目录
		// 解析相对路径,PluginContext 没有把那个 cwd 递给插件——这里唯一拿得到的基准是
		// process.cwd()。如果只是拿一个"相对 process.cwd() 也不存在"的相对路径来测,拒绝
		// 相对路径这条分支和"路径不存在也拦"那条分支会给出同一个结果,测不出 isAbsolute 检查
		// 本身有没有在生效。这里把 process.cwd()(即 packages/task-runtime,本仓测试的运行
		// 目录,`package.json` 在这里真实存在)本身设成白名单根,再传一个相对路径
		// "package.json"——它按 process.cwd() 解析确实落在白名单内、文件也确实存在,一旦
		// isAbsolute 检查被去掉就会被 ALLOW(变异验证见 task-11-report.md);但这个"落在白名单
		// 内"只是 process.cwd() 恰好如此,并不是 read 工具真正会用的 session cwd 算出来的
		// 结论,方向不可信,必须无条件拦。
		const handler = instantiate([process.cwd()]);
		expect(await handler({ toolName: "read", input: { path: "package.json" } })).toMatchObject({ block: true });
	});

	it("does not resolve a relative allowRoots entry against process.cwd(), even when it happens to match a real directory there", async () => {
		// 顺带做的一条(复审 2026-07-31,与 I-2 对称):不用 process.chdir()——vitest 可能并发
		// 跑多个测试文件,chdir 是进程级状态,会有跨测试污染风险。这里直接用测试实际运行时的
		// process.cwd()(即 packages/task-runtime,本仓约定的 vitest 运行目录)构造反例:传一个
		// 相对根 "src",它按 process.cwd() 解析确实是一个真实存在的目录,里面确实有
		// src/runtime/assembler.ts——如果没有 isAbsolute(expandedRoot) 这道校验,这个相对根
		// 会被当成合法根、放行这次读取;有了这道校验,相对根被跳过(不匹配任何已声明的根),
		// 读取被拦。
		const handler = instantiate(["src"]);
		const target = join(process.cwd(), "src", "runtime", "assembler.ts");
		expect(await handler({ toolName: "read", input: { path: target } })).toMatchObject({ block: true });
	});

	it("expands <runId> in allowRoots", async () => {
		const handler = instantiate([join(root, "uploads", "<runId>")], "run-1");
		expect(await handler({ toolName: "read", input: { path: join(allowed, "ok.txt") } })).toBeUndefined();
	});

	it("blocks when <runId> expands to a root that does not exist", async () => {
		const handler = instantiate([join(root, "uploads", "<runId>")], "other-run");
		expect(await handler({ toolName: "read", input: { path: join(allowed, "ok.txt") } })).toMatchObject({
			block: true,
		});
	});

	it("blocks everything when allowRoots is empty", async () => {
		const handler = instantiate([]);
		expect(await handler({ toolName: "read", input: { path: join(allowed, "ok.txt") } })).toMatchObject({
			block: true,
		});
	});

	it("re-evaluates <runId> on every call, not once at instantiation (I-1: S3 pools one session across many runs)", async () => {
		// 永久锁(复审 I-1,2026-07-31):`instantiate()` 每次都新建一个 handler,测不出
		// "实例化时展开一次"和"每次调用时展开"的差异——两种实现在那些用例下表现完全一样。
		// 这里手工搭一个可变的 ctx.getRunId(),同一个 handler 实例先后驱动两个不同的 runId,
		// 不重新实例化插件——这正是 S3 按 specId 池化后,一个 SessionRuntime 实例跨多个 run
		// 复用的形状。若把 `ctx.getRunId()` 挪到 factory 实例化时求值一次,这条测试会翻红,
		// 而 path-guard.test.ts 其余用例、乃至全仓 327 条都测不出来(已用变异验证复现,见
		// task-11-report.md)。
		const dirB = join(root, "uploads", "run-2");
		await mkdir(dirB, { recursive: true });
		await writeFile(join(dirB, "b.txt"), "b");

		let currentRunId = "run-1";
		let handler: ((event: unknown) => Promise<unknown>) | undefined;
		const ctx: PluginContext = {
			specId: "s1",
			getRunId: () => currentRunId,
			getRunInput: () => "",
			getSession: () => ({ getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }) }) as never,
			abort: () => {},
			limitState: { turns: 0 },
			registerFinalJudge: () => {},
		};
		const extension = pathGuardDescriptor.factory(ctx, { allowRoots: [join(root, "uploads", "<runId>")] });
		const factory = typeof extension === "function" ? extension : extension.factory;
		(factory as (api: unknown) => void)({
			on: (_type: string, h: (event: unknown) => Promise<unknown>) => {
				handler = h;
			},
		});

		expect(await handler!({ toolName: "read", input: { path: join(allowed, "ok.txt") } })).toBeUndefined();
		expect(await handler!({ toolName: "read", input: { path: join(dirB, "b.txt") } })).toMatchObject({
			block: true,
		});

		currentRunId = "run-2"; // 同一个插件实例跨 run 复用,不重新实例化 handler
		expect(await handler!({ toolName: "read", input: { path: join(dirB, "b.txt") } })).toBeUndefined();
		expect(await handler!({ toolName: "read", input: { path: join(allowed, "ok.txt") } })).toMatchObject({
			block: true,
		});
	});
});
