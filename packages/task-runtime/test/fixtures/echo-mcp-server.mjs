#!/usr/bin/env node
// 最小 MCP stdio server:initialize / tools/list / tools/call
import { createInterface } from "node:readline";

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
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { content: [{ type: "text", text: String(msg.params.arguments?.text ?? "") }] },
		});
		return;
	}
	send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});
