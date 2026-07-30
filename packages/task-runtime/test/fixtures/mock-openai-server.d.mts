/**
 * 手写的伴生声明文件:mock-openai-server.mjs 是纯 JS fixture(形态参照 echo-mcp-server.mjs,
 * 同为测试专用、同样 .mjs),但和 echo-mcp-server.mjs 不同的是它要被 test/cli.test.ts 直接
 * import 进同一个测试进程(用来在 spawn CLI 子进程前先拿到随机监听端口),而不是只被当独立子
 * 进程 spawn。NodeNext 模块解析下,TS 会自动把同名 .d.mts 当作 .mjs 的类型声明,不需要改
 * tsconfig 开 allowJs。
 */

export interface MockOpenAiServerToolCall {
	name: string;
	arguments?: Record<string, unknown>;
	id?: string;
}

export interface MockOpenAiServerOptions {
	/** 若提供,首轮响应会是一次工具调用;第二轮(消息里已含 role:"tool")才收尾。 */
	toolCall?: MockOpenAiServerToolCall;
	/** 收尾消息的文本内容,默认 "mock: task complete." */
	finalText?: string;
}

export interface MockOpenAiServerHandle {
	readonly port: number;
	/** 拼进 ProviderProfile.baseUrl 用,已含 "/v1" 后缀。 */
	readonly baseUrl: string;
	/** 按到达顺序记录的原始请求体,供测试内省(比如断言工具轮确实发生过)。 */
	readonly requests: readonly Record<string, unknown>[];
	close(): Promise<void>;
}

export function startMockOpenAiServer(options?: MockOpenAiServerOptions): Promise<MockOpenAiServerHandle>;
