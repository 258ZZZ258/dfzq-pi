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
	/**
	 * SIGTERM 后等待子进程自行退出的时间上限,超时后升级为 SIGKILL。默认见
	 * `DEFAULT_DISPOSE_TIMEOUT_MS`。真实 MCP server(尤其是 Python 实现)可能在收到
	 * SIGTERM 后做清理(关连接、flush 日志),比测试用的 node fixture 慢得多。
	 */
	disposeTimeoutMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "SystemRoot", "TMPDIR"] as const;

/**
 * SIGTERM 后等待子进程自行退出的默认时间上限。2s 足够绝大多数「优雅关闭」逻辑跑完(关连接、
 * flush 日志),同时不会让失败路径上的批量 dispose(比如 Task 6 装配器在工具名 typo / 插件冲突
 * 后的清理)被拖慢太久。
 */
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

/**
 * SIGKILL 之后的兜底等待时间。SIGKILL 本身无法被子进程捕获或忽略,理论上 exit 应该几乎立即
 * 触发;这个常量只是防止操作系统调度延迟等极端情况让 dispose() 真的挂起 —— 到点无论 exit
 * 事件是否触发都强制 resolve,保证 dispose() 有一个绝对的返回上界。
 */
const SIGKILL_GRACE_MS = 500;

/** stderr 诊断尾巴的容量上限,防止 server 疯狂打日志时无界增长(内存 / 错误消息都要有界)。 */
const STDERR_TAIL_MAX_LINES = 20;
const STDERR_LINE_MAX_CHARS = 300;

export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private tools: McpToolInfo[] = [];
	private disposed = false;
	private readonly stderrTail: string[] = [];

	private readonly id: string;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly reader: Interface;
	private readonly stderrReader: Interface;
	private readonly requestTimeoutMs: number;
	private readonly disposeTimeoutMs: number;

	private constructor(
		id: string,
		child: ChildProcessWithoutNullStreams,
		reader: Interface,
		stderrReader: Interface,
		requestTimeoutMs: number,
		disposeTimeoutMs: number,
	) {
		this.id = id;
		this.child = child;
		this.reader = reader;
		this.stderrReader = stderrReader;
		this.requestTimeoutMs = requestTimeoutMs;
		this.disposeTimeoutMs = disposeTimeoutMs;
	}

	/** 子进程 pid,主要用于测试/诊断(存活探测等);进程未启动或已回收时为 undefined。 */
	get pid(): number | undefined {
		return this.child.pid;
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
		// 必须主动消费 child.stderr:管道缓冲通常只有 ~64KB,MCP server(尤其是用阻塞式 stdio
		// 写法的 Python 实现)往 stderr 打日志一旦超过这个量,写入就会卡住,现象是"MCP 调用超时"
		// 而不是报错,排查成本很高。这里不关心内容对不对,只关心"读走"这个动作本身。
		const stderrReader = createInterface({ input: child.stderr });
		const client = new McpClient(
			options.id,
			child,
			reader,
			stderrReader,
			options.requestTimeoutMs ?? 30_000,
			options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
		);

		reader.on("line", (line) => client.onLine(line));
		stderrReader.on("line", (line) => client.onStderrLine(line));
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
			throw new Error(
				`MCP server "${options.id}" failed to initialize: ${(error as Error).message}${client.stderrSummary()}`,
			);
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
			return {
				text: `MCP tool "${name}" failed: ${(error as Error).message}${this.stderrSummary()}`,
				isError: true,
			};
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.failAll(new Error(`MCP client "${this.id}" is disposed`));
		this.reader.close();
		this.stderrReader.close();
		this.child.stdin.end();
		await this.terminateChild();
	}

	/**
	 * SIGTERM -> 等待 exit -> 超时未退则 SIGKILL -> 再等一小段兜底。无论子进程是否配合,
	 * 都在有限时间内 resolve —— 否则失败路径上反复 dispose() 会攒下孤儿子进程(见
	 * fix round 1/5 code review)。
	 */
	private terminateChild(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			let settled = false;
			let forceTimer: NodeJS.Timeout | undefined;

			const finish = () => {
				if (settled) return;
				settled = true;
				this.child.removeListener("exit", finish);
				clearTimeout(termTimer);
				if (forceTimer) clearTimeout(forceTimer);
				resolve();
			};

			this.child.once("exit", finish);
			this.child.kill("SIGTERM");
			const termTimer = setTimeout(() => {
				this.child.kill("SIGKILL");
				forceTimer = setTimeout(finish, SIGKILL_GRACE_MS);
			}, this.disposeTimeoutMs);
		});
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

	/** 只是「读走」以防管道堵塞;顺带留一份有界的诊断尾巴,方便 initialize/callTool 失败时定位问题。 */
	private onStderrLine(line: string): void {
		if (!line) return;
		const trimmed = line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…` : line;
		this.stderrTail.push(trimmed);
		if (this.stderrTail.length > STDERR_TAIL_MAX_LINES) this.stderrTail.shift();
	}

	private stderrSummary(): string {
		return this.stderrTail.length > 0 ? ` (recent stderr: ${this.stderrTail.join(" | ")})` : "";
	}

	private failAll(error: Error): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
}
