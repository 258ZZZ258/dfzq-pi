import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
