import { createInterface } from "node:readline";

const tools = ["search_policy", "get_clause_detail"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } }));
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	let result;
	if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "empty-search", version: "1" } };
	else if (message.method === "tools/list") result = { tools };
	else result = { content: [{ type: "text", text: '{"hits":[]}' }] };
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
