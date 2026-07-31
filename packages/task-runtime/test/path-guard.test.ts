import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import type { PluginContext } from "../src/runtime/plugin-registry.ts";
import { pathGuardDescriptor } from "../src/runtime/plugins/path-guard.ts";

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
