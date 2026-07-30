import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, type McpSpawnOptions } from "../src/toolsets/mcp/client.ts";

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

// fix round 2/5:字面量必须和 test/fixtures/echo-mcp-server.mjs 里的同名常量保持一致 —— fixture
// 是独立 spawn 的子进程,不能 import 常量模块(那样会在测试进程里跑一份 fixture 的顶层副作用)。
const CALL_STDERR_SENTINEL = "SENTINEL_MCP_CALLTOOL_STDERR_PROBE";
const INIT_STDERR_SENTINEL = "SENTINEL_MCP_INIT_STDERR_PROBE";

const clients: McpClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.dispose();
});

type SpawnExtra = Partial<Omit<McpSpawnOptions, "id" | "command" | "args" | "env">>;

async function spawn(env?: Record<string, string>, extra?: SpawnExtra) {
	const client = await McpClient.spawn({
		id: "echo",
		command: process.execPath,
		args: [SERVER],
		env: env ?? {},
		...extra,
	});
	clients.push(client);
	return client;
}

/** POSIX 存活探测:kill(pid, 0) 不发信号,只检查进程是否还在(有权限访问)。*/
function isAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("McpClient", () => {
	it("initializes and lists tools", async () => {
		const client = await spawn();
		const names = client
			.listTools()
			.map((t) => t.name)
			.sort();
		expect(names).toEqual(["boom", "echo", "leak"]);
		expect(client.listTools().find((t) => t.name === "echo")?.inputSchema).toMatchObject({ type: "object" });
	});

	it("calls a tool and returns text content", async () => {
		const client = await spawn();
		const result = await client.callTool("echo", { text: "hi there" });
		expect(result.isError).toBe(false);
		expect(result.text).toBe("hi there");
	});

	it("maps a JSON-RPC error to isError instead of throwing", async () => {
		const client = await spawn();
		const result = await client.callTool("boom", {});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("boom failed");
	});

	it("passes only whitelisted env to the child process", async () => {
		process.env.DFZQ_SECRET_PROBE = "must-not-leak";
		const client = await spawn({ ALLOWED_VALUE: "ok" });
		const result = await client.callTool("leak", {});
		const env = JSON.parse(result.text) as Record<string, string>;
		expect(env.ALLOWED_VALUE).toBe("ok");
		expect(env.DFZQ_SECRET_PROBE).toBeUndefined();
		delete process.env.DFZQ_SECRET_PROBE;
	});

	it("rejects calls after dispose", async () => {
		const client = await spawn();
		await client.dispose();
		clients.length = 0;
		await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/disposed/i);
	});

	// fix round 1/5:Task 10 会 spawn 真实的 Python MCP server —— 它可能往 stderr 打大量日志。
	// fixture 的 "spam-stderr"(不在 listTools() 里,专为此测试隐藏添加)用 fs.writeSync 同步写
	// stderr:如果 client 不主动消费 child.stderr,管道缓冲(约 64KB)填满后子进程会阻塞在
	// write() 上,现象就是这次 tools/call 迟迟不返回、最终撞上 requestTimeoutMs 超时。
	it("drains child stderr so a synchronous stderr flood doesn't block a tool call", async () => {
		const client = await spawn(undefined, { requestTimeoutMs: 4_000 });
		const start = Date.now();
		const result = await client.callTool("spam-stderr", {});
		const elapsed = Date.now() - start;
		expect(result.isError).toBe(false);
		expect(result.text).toBe("spammed");
		// 只要 stderr 被持续消费,这次调用应该在几百毫秒内完成,远低于 4s 的 requestTimeoutMs。
		// 若 client 不读 stderr,这个调用会一路等到超时(挂钟时间 ~4s)才 reject,这里用一个
		// 远低于超时阈值的上界来分辨"正常完成"和"卡到超时"两种情况。
		expect(elapsed).toBeLessThan(2_000);
	});

	// fix round 1/5:真实 Python MCP server 可能捕获 SIGTERM 做清理,退出比 node fixture 慢得多。
	// dispose() 必须「发终止信号 -> 等 exit -> 超时未退则 SIGKILL 升级」,且无论子进程配不配合都要
	// 在有限时间内返回 —— 否则装配器失败路径上的重复 dispose() 会攒下孤儿 Python 进程。
	it("escalates to SIGKILL when the child ignores SIGTERM, bounding dispose() to a finite time", async () => {
		const client = await spawn({ MCP_FIXTURE_IGNORE_SIGTERM: "1" }, { disposeTimeoutMs: 200 });
		expect(isAlive(client.pid)).toBe(true);

		const start = Date.now();
		await client.dispose();
		const elapsed = Date.now() - start;

		// 确实等过一轮 SIGTERM 宽限期才升级,不是立刻就 SIGKILL。
		expect(elapsed).toBeGreaterThanOrEqual(200);
		// 但无论子进程是否配合,dispose() 必须在有限时间内返回 —— 不能永久挂起。
		expect(elapsed).toBeLessThan(2_000);
		// 子进程被真正回收,不是"dispose() 返回了但进程还活着"的孤儿。
		expect(isAlive(client.pid)).toBe(false);
	});

	// fix round 2/5:stderr 按受众路由,不是脱敏。callTool() 失败返回给模型的 text 只应该有 MCP
	// 自己的 error message —— 模型修不了 MCP server 的问题(装不了依赖、改不了路径),子进程的
	// 原始调试输出对它零收益,反而白白扩大凭据泄漏面(stderr 是操作者调试通道,崩溃现场最容易吐
	// 连接串/token/env dump)。stderr 细节改道 console.error(运维通道,和 Task 8 abortFn 同一个
	// 出口),这里同时断言"没进模型的 text"和"确实到了 console.error",证明是结构性路由而不是
	// 静默丢弃。
	it("routes callTool failure stderr to console.error instead of the text returned to the model", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const client = await spawn(undefined, { requestTimeoutMs: 4_000 });
			const result = await client.callTool("stderr-then-fail", {});

			expect(result.isError).toBe(true);
			// MCP 自己的语义化错误摘要还在 —— 模型知道"这次失败了、为什么失败"。
			expect(result.text).toContain("stderr-then-fail failed");
			// 但子进程的 stderr 原始输出不该混进去。
			expect(result.text).not.toContain(CALL_STDERR_SENTINEL);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0]?.[0]).toContain(CALL_STDERR_SENTINEL);
		} finally {
			errorSpy.mockRestore();
		}
	});

	// fix round 2/5:与上一条相反的路径 —— initialize 失败的 throw 不经过模型,是 assemble()
	// 装配期抛给 CLI/运维的,stderr(比如 Python 的 traceback)正是运维排查"server 为什么起不来"
	// 需要的信息,所以这条路径上 stderrSummary() 原样保留,这里断言哨兵确实出现在抛出的错误里。
	it("keeps stderr detail in the initialize-failure throw (ops channel, not model-facing)", async () => {
		await expect(
			McpClient.spawn({
				id: "echo",
				command: process.execPath,
				args: [SERVER],
				env: { MCP_FIXTURE_FAIL_INIT_WITH_STDERR: "1" },
			}),
		).rejects.toThrow(new RegExp(INIT_STDERR_SENTINEL));
	});
});
