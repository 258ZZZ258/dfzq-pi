#!/usr/bin/env node
// 最小 MCP stdio server:initialize / tools/list / tools/call
import fs from "node:fs";
import { createInterface } from "node:readline";

// fix round 2/5:两个哨兵字符串,分别验证 stderr 按受众路由到 callTool()(不该到模型)和
// spawn() 的 initialize 失败 throw(该到运维)两条路径。这个进程会被当独立子进程 spawn,不会被
// test 文件 import,所以字面量在 mcp-client.test.ts 里重复了一份 —— 改这里记得同步改那边。
const CALL_STDERR_SENTINEL = "SENTINEL_MCP_CALLTOOL_STDERR_PROBE";
const INIT_STDERR_SENTINEL = "SENTINEL_MCP_INIT_STDERR_PROBE";

// fix round 2/5:MCP_FIXTURE_FAIL_INIT_WITH_STDERR=1 时,进程一启动(早于任何 stdin 读取)就往
// stderr 打一个哨兵,之后 initialize 请求会回一个 JSON-RPC error(见下方 handler)。在模块顶层
// 同步写、而不是等收到 initialize 请求才写,是为了确定性地避免时序竞争:子进程启动到父进程真正
// 发出 initialize 请求之间天然有一段进程间通信延迟,这段时间足够父进程的独立 stderr reader 把这
// 一行读走、落进 stderrTail,不需要额外人为 delay。
if (process.env.MCP_FIXTURE_FAIL_INIT_WITH_STDERR === "1") {
	process.stderr.write(`${INIT_STDERR_SENTINEL}\n`);
}

// fix round 1/5:模拟真实(尤其是 Python)MCP server 收到 SIGTERM 后拖着不退出的情况,
// 用于测试 client 端 dispose() 的 SIGKILL 升级路径。
if (process.env.MCP_FIXTURE_IGNORE_SIGTERM === "1") {
	process.on("SIGTERM", () => {
		// 故意吞掉,不退出 —— 逼客户端升级成 SIGKILL。
	});
	// 只挂 SIGTERM 处理器不够:dispose() 会先 end() 掉子进程的 stdin,readline 收到 EOF 后,
	// 如果没有其它活跃句柄,Node 会自然退出——那样测的就不是"忽略 SIGTERM"而是"stdin 关了正常退出"。
	// 用一个不会被清理的 interval 保活,直到真的被 SIGKILL。
	setInterval(() => {}, 1_000);
}

const TOOLS = [
	{
		name: "echo",
		description: "Echo the given text back.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "Text to echo" } },
			required: ["text"],
		},
	},
	{
		name: "boom",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "leak",
		description: "Dump env.",
		inputSchema: { type: "object", properties: {} },
	},
];

// fix round 1/5(Task 10):MCP_FIXTURE_EXTRA_TOOL=<name> 时,给这个 server 实例额外挂一个只有
// 它自己有的工具,用来测"两个 server 部分撞名(echo/boom/leak 共有 + 各自独有一个)"的非对称
// 前缀场景 —— 之前的撞名测试两个 server 都是同一份 TOOLS,全部对称撞名,测不出"不撞名的名字
// 不该加前缀"这条分支。没有显式 tools/call 处理分支:落到文件末尾的通用 echo-like 兜底即可。
if (process.env.MCP_FIXTURE_EXTRA_TOOL) {
	TOOLS.push({
		name: process.env.MCP_FIXTURE_EXTRA_TOOL,
		description: "Extra tool unique to this fixture instance.",
		inputSchema: { type: "object", properties: {} },
	});
}

function send(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
		if (process.env.MCP_FIXTURE_FAIL_INIT_WITH_STDERR === "1") {
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "initialize failed" } });
			return;
		}
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "0" } },
		});
		return;
	}
	if (msg.method === "notifications/initialized") return;
	if (msg.method === "tools/list") {
		send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
		return;
	}
	if (msg.method === "tools/call") {
		// Task 15:EVAL_TASK_LOG 是 S0 出口判据②(对账)的数据来源,链路是
		// main.ts 读 process.env.EVAL_TASK_LOG → 注入每个 McpServerSpec.env → McpClient.spawn
		// 的白名单 env(不继承 process.env,见 client.ts)。这里落一行 JSON 证明 env 真的到了
		// 这个子进程 —— 单元测试看不到这条链路,只有真实跨进程 spawn 才测得出。
		if (process.env.EVAL_TASK_LOG) {
			try {
				fs.appendFileSync(
					process.env.EVAL_TASK_LOG,
					`${JSON.stringify({
						ts: Date.now(),
						server: "echo",
						tool: msg.params.name,
						arguments: msg.params.arguments ?? {},
					})}\n`,
				);
			} catch {
				// 日志是尽力而为的观测,不能因为写失败就打断这个 fixture 本该做的 MCP 协议响应。
			}
		}
		if (msg.params.name === "boom") {
			send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom failed" } });
			return;
		}
		if (msg.params.name === "leak") {
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: { content: [{ type: "text", text: JSON.stringify(process.env) }] },
			});
			return;
		}
		if (msg.params.name === "stderr-then-fail") {
			// 故意不放进 TOOLS。验证 callTool() 失败时返回给模型的 text 不含 stderr 内容
			// (stderr 只进运维通道 console.error,不进模型上下文)。stdout 响应延迟一小段再发,
			// 给父进程独立的 stderr reader 留出确定性的时间窗口先把这行读走、落进 stderrTail——
			// 否则两个 write() 背靠背发出,两条 pipe 各自被处理的先后顺序没有保证,会让"console.error
			// 是否已经带上这行"这个断言变成时序竞争、跑出 flaky。
			process.stderr.write(`${CALL_STDERR_SENTINEL}\n`);
			setTimeout(() => {
				send({ jsonrpc: "2.0", id: msg.id, error: { code: -32003, message: "stderr-then-fail failed" } });
			}, 30);
			return;
		}
		if (msg.params.name === "spam-stderr") {
			// 故意不放进 TOOLS(不影响 listTools() 断言),只用于 stderr 背压测试。
			// 用 fs.writeSync 而非 process.stderr.write:后者在 Node 里对 pipe 是异步的,不会真的
			// 阻塞主线程,测不出问题;fs.writeSync 是同步系统调用,管道满了就真的会阻塞 ——
			// 这才是真实 Python MCP server 默认 stdio 写法的行为,是本测试要覆盖的场景。
			const chunk = Buffer.from(`${"x".repeat(200)}\n`);
			for (let i = 0; i < 3000; i++) {
				fs.writeSync(2, chunk);
			}
			send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "spammed" }] } });
			return;
		}
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { content: [{ type: "text", text: String(msg.params.arguments?.text ?? "") }] },
		});
		return;
	}
	send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});
