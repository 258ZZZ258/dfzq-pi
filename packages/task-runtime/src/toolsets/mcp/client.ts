import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
	text: string;
	isError: boolean;
}

export interface McpSpawnOptions {
	id: string;
	command: string;
	args: string[];
	/** 白名单 env —— 不继承 process.env(安全方案 L1(a))。PATH/HOME/LANG 自动补。 */
	env: Record<string, string>;
	cwd?: string;
	requestTimeoutMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "SystemRoot", "TMPDIR"] as const;

export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private tools: McpToolInfo[] = [];
	private disposed = false;

	private readonly id: string;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly reader: Interface;
	private readonly requestTimeoutMs: number;

	private constructor(id: string, child: ChildProcessWithoutNullStreams, reader: Interface, requestTimeoutMs: number) {
		this.id = id;
		this.child = child;
		this.reader = reader;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	static async spawn(options: McpSpawnOptions): Promise<McpClient> {
		const env: Record<string, string> = {};
		for (const key of BASE_ENV_KEYS) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		Object.assign(env, options.env);

		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;

		const reader = createInterface({ input: child.stdout });
		const client = new McpClient(options.id, child, reader, options.requestTimeoutMs ?? 30_000);

		reader.on("line", (line) => client.onLine(line));
		child.on("exit", (code) => client.failAll(new Error(`MCP server "${options.id}" exited with code ${code}`)));
		child.on("error", (error) => client.failAll(error));

		try {
			await client.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "@dfzq/task-runtime", version: "0.0.1" },
			});
			client.notify("notifications/initialized", {});
			const listed = (await client.request("tools/list", {})) as { tools?: McpToolInfo[] };
			client.tools = listed.tools ?? [];
		} catch (error) {
			await client.dispose();
			throw new Error(`MCP server "${options.id}" failed to initialize: ${(error as Error).message}`);
		}
		return client;
	}

	listTools(): McpToolInfo[] {
		return this.tools;
	}

	/** MCP 错误映射成 isError,不抛 —— 抛出去会打断循环,而模型能从错误结果里恢复。 */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		if (this.disposed) throw new Error(`MCP client "${this.id}" is disposed`);
		try {
			const result = (await this.request("tools/call", { name, arguments: args }, signal)) as {
				content?: Array<{ type: string; text?: string }>;
				isError?: boolean;
			};
			const text = (result.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			return { text, isError: Boolean(result.isError) };
		} catch (error) {
			return { text: `MCP tool "${name}" failed: ${(error as Error).message}`, isError: true };
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.failAll(new Error(`MCP client "${this.id}" is disposed`));
		this.reader.close();
		this.child.stdin.end();
		this.child.kill();
	}

	private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout after ${this.requestTimeoutMs}ms`));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			signal?.addEventListener(
				"abort",
				() => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					clearTimeout(entry.timer);
					this.notify("notifications/cancelled", { requestId: id });
					entry.reject(new Error("aborted"));
				},
				{ once: true },
			);
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	private notify(method: string, params: unknown): void {
		if (this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		let message: { id?: number; result?: unknown; error?: { code: number; message: string } };
		try {
			message = JSON.parse(line);
		} catch {
			return; // 非 JSON 行(server 的调试输出)直接忽略
		}
		if (message.id === undefined) return;
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) {
			entry.reject(new Error(`[${message.error.code}] ${message.error.message}`));
			return;
		}
		entry.resolve(message.result);
	}

	private failAll(error: Error): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
}
