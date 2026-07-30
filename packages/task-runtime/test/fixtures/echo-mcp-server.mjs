#!/usr/bin/env node
// 最小 MCP stdio server:initialize / tools/list / tools/call
import fs from "node:fs";
import { createInterface } from "node:readline";

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

function send(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === "initialize") {
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
