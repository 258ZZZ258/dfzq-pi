#!/usr/bin/env node
// 本地 OpenAI 兼容 mock HTTP server:CLI 是 execFile spawn 出的新子进程,自己读
// profile.json、自己调 ModelRuntime.registerProvider,看不到父进程内 registerFauxProvider()
// 打的 patch(那是 createFauxHarness() 的机制,只对同进程内的 pi-ai api-registry 生效)。
// 所以子进程必须真的能拨通一个 HTTP 端点 —— 这个 server 就是那个端点。
//
// 契约来自读 packages/ai/src/api/openai-completions.ts 的结论(见 task-15-report.md):
//   - client.chat.completions.create(params, ...).withResponse():params.stream 恒为 true,
//     一次请求即走流式。
//   - OpenAI SDK 是否走 SSE 解析由请求的 `stream:true` 决定,不看响应 Content-Type
//     (node_modules/openai/src/internal/parse.ts:24 `if (props.options.stream)`)。
//   - SSE 帧格式:`data: <json>\n\n`,以 `data: [DONE]\n\n` 收尾
//     (node_modules/openai/src/core/streaming.ts SSEDecoder)。
//   - 每个 chunk 是 ChatCompletionChunk:{id, object, created, model, choices:[{index,
//     delta, finish_reason}], usage?}。stopReason 由 choice.finish_reason 决定:
//     "stop"→stop,"tool_calls"→toolUse。stream 结束前必须至少出现一次 finish_reason,
//     否则 openai-completions.ts 会抛 "Stream ended without finish_reason"。
//   - 工具调用走 choice.delta.tool_calls:[{index,id,type:"function",
//     function:{name, arguments}}]——arguments 可以一次性给全,parseStreamingJson 能处理
//     完整 JSON 字符串。
//
// 与 echo-mcp-server.mjs 同为测试专用 fixture、同样约定由调用方 close()/afterEach 清理。
// 不同于 echo-mcp-server.mjs(必须是独立子进程,因为 MCP client 用 stdio spawn 它),这个
// server 跑在测试进程内即可 —— CLI 子进程通过真实 TCP 回环连过来,不需要它自己也是子进程。

import { createServer } from "node:http";

/**
 * @param {object} [options]
 * @param {{ name: string, arguments?: Record<string, unknown>, id?: string }} [options.toolCall]
 *   若提供,且请求里还没有 role:"tool" 的消息(即还没发生过一轮工具调用),第一轮响应会是
 *   一次工具调用(finish_reason:"tool_calls");agent 执行完工具后发起的第二轮请求(消息里已
 *   带 role:"tool")会落到 else 分支,返回收尾的 "stop" 消息。
 * @param {string} [options.finalText] 收尾消息的文本内容。
 */
export async function startMockOpenAiServer(options = {}) {
	const { toolCall, finalText = "mock: task complete." } = options;
	/** @type {any[]} 按到达顺序记录的原始请求体,供测试内省(比如断言工具轮是否真的发生过)。 */
	const requests = [];

	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `mock-openai-server: invalid JSON body: ${String(error)}` } }));
				return;
			}
			requests.push(body);

			const messages = Array.isArray(body.messages) ? body.messages : [];
			const hasToolResult = messages.some((message) => message?.role === "tool");

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			const id = `chatcmpl-mock-${requests.length}`;
			const created = Math.floor(Date.now() / 1000);
			const model = typeof body.model === "string" ? body.model : "mock-model";
			const base = { id, object: "chat.completion.chunk", created, model };

			const sendChunk = (partial) => {
				res.write(`data: ${JSON.stringify({ ...base, ...partial })}\n\n`);
			};

			if (toolCall && !hasToolResult) {
				sendChunk({
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: toolCall.id ?? "call_mock_1",
										type: "function",
										function: {
											name: toolCall.name,
											arguments: JSON.stringify(toolCall.arguments ?? {}),
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				});
				sendChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
			} else {
				sendChunk({
					choices: [{ index: 0, delta: { role: "assistant", content: finalText }, finish_reason: null }],
				});
				sendChunk({
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
				});
			}

			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		// listen(0, ...):随机可用端口,避免并发测试撞端口。
		server.listen(0, "127.0.0.1", () => resolve(undefined));
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve(undefined)));
			}),
	};
}
