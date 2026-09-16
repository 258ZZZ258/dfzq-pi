import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/memory/service.ts";
import type { SessionCheckpoint } from "../src/runtime/checkpoint.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { createFastPathRuntime } from "../src/runtime/fast-path-runtime.ts";
import { createSessionRuntime } from "../src/runtime/session-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { createSqliteStateStore } from "../src/state/store.ts";
import { ToolLedger } from "../src/state/tool-ledger.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { startMockOpenAiServer } from "./fixtures/mock-openai-server.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
	vi.unstubAllEnvs();
});

async function options(baseUrl: string) {
	const root = await mkdtemp(join(tmpdir(), "runtime-installed-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	vi.stubEnv("DFZQ_PRODUCTION_SMOKE_KEY", "local-test-only");
	const toolsets = new ToolsetRegistry();
	toolsets.register("demo", async () => [
		{
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, args) => ({
				content: [{ type: "text", text: (args as { text: string }).text }],
				details: {},
			}),
		},
		{
			name: "search_policy",
			label: "search",
			description: "synthetic search",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: '{"hits":[{"clause_id":"C1"}]}' }], details: {} }),
		},
		{
			name: "get_clause_detail",
			label: "detail",
			description: "synthetic detail",
			parameters: Type.Object({ clause_ids: Type.Array(Type.String()) }),
			execute: async () => ({
				content: [{ type: "text", text: '{"items":[{"clause_id":"C1","text":"body"}]}' }],
				details: {},
			}),
		},
	]);
	const spec: RuntimeSpec = {
		id: "installed-smoke",
		model: { role: "main" },
		toolset: "demo",
		tools: ["echo"],
		limits: { maxTurns: 5, runTimeoutMs: 5000 },
		outputContract: { schema: "inline", maxRepairAttempts: 1 },
	};
	return {
		spec,
		toolsets,
		registry: createDefaultPluginRegistry(),
		cwd: join(root, "cwd"),
		agentDir: join(root, "agent"),
		outputContractSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
		profile: {
			id: "local",
			baseUrl,
			apiKeyEnv: "DFZQ_PRODUCTION_SMOKE_KEY",
			api: "openai-completions" as const,
			roles: {
				main: {
					provider: "local-test",
					modelId: "mock-model",
					contextWindow: 8192,
					maxTokens: 1024,
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			},
		},
	};
}

async function pendingServer() {
	let entered!: () => void;
	const requestStarted = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let calls = 0;
	const server = createServer((_req, res) => {
		calls += 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(
			`data: ${JSON.stringify({ id: "pending", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`,
		);
		entered();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("missing test listener address");
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requestStarted, calls: () => calls };
}

describe("installed-runtime HTTP boundary", () => {
	it("refuses to resume a checkpoint containing a memory deleted since capture", async () => {
		const mock = await startMockOpenAiServer({ finalText: '{"ok":true}' });
		cleanups.push(mock.close);
		const opts = await options(mock.baseUrl);
		const store = createSqliteStateStore(":memory:");
		cleanups.push(() => store.close());
		const service = new MemoryService(store);
		const scope = { tenantId: "t", userId: "u" };
		const memory = await service.propose(
			scope,
			{ text: "请简洁回答", category: "preference", source: "user", sourceRef: "user" },
			"k",
		);
		let checkpoint: SessionCheckpoint | undefined;
		const first = await createSessionRuntime({
			...opts,
			memory: { service, scope },
			onCheckpoint: async (value) => {
				checkpoint = value;
			},
		});
		await first.run("question", { runId: "r" });
		await first.dispose();
		if (!checkpoint) throw new Error("missing checkpoint");
		await service.remove(scope, memory.id, memory.revision);
		await expect(createSessionRuntime({ ...opts, memory: { service, scope }, resume: checkpoint })).rejects.toThrow(
			"checkpoint_memory_stale",
		);
		expect(mock.requests).toHaveLength(1);
	});
	it("resumes a persisted pending tool call in a new session without repeating a completed side effect", async () => {
		const mock = await startMockOpenAiServer({
			toolCall: { name: "echo", arguments: { text: "test" } },
			finalText: '{"ok":true}',
		});
		cleanups.push(mock.close);
		const opts = await options(mock.baseUrl);
		const stateStore = createSqliteStateStore(":memory:");
		cleanups.push(() => stateStore.close());
		const ledger = new ToolLedger(stateStore);
		let executions = 0;
		const toolsets = new ToolsetRegistry();
		toolsets.register("demo", async () => [
			{
				name: "echo",
				label: "echo",
				description: "write fixture",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (callId, args) =>
					(await ledger.execute(
						{
							scope: "test",
							runId: "root",
							callId,
							tool: "echo",
							effect: "non_idempotent_write",
							args: args as Record<string, unknown>,
						},
						async () => {
							executions++;
							return { content: [{ type: "text", text: "test" }], details: {} };
						},
					)) as { content: Array<{ type: "text"; text: string }>; details: Record<string, never> },
			},
		]);
		let checkpoint: SessionCheckpoint | undefined;
		const first = await createSessionRuntime({
			...opts,
			toolsets,
			onCheckpoint: async (value) => {
				if (value.next === "pending_tools") checkpoint = JSON.parse(JSON.stringify(value)) as SessionCheckpoint;
				else throw new Error("simulate failed checkpoint commit after side effect");
			},
		});
		const failed = await first.run("call echo then finish", { runId: "root" });
		expect(failed.status).toBe("error");
		expect(executions).toBe(1);
		await first.dispose();
		if (!checkpoint) throw new Error("missing before-tool checkpoint");
		const resumed = await createSessionRuntime({ ...opts, toolsets, resume: checkpoint });
		cleanups.push(resumed.dispose);
		const completed = await resumed.run("call echo then finish", { runId: "attempt-2" });
		expect(completed.status).toBe("completed");
		expect(completed.turns).toBe(2);
		expect(executions).toBe(1);
		expect(mock.requests).toHaveLength(2);
	});
	it("executes a tool and enforces the output contract with actual installed provider code", async () => {
		const mock = await startMockOpenAiServer({
			toolCall: { name: "echo", arguments: { text: "test" } },
			finalText: '{"ok":true}',
		});
		cleanups.push(mock.close);
		const runtime = await createSessionRuntime(await options(mock.baseUrl));
		cleanups.push(runtime.dispose);
		const events: string[] = [];
		runtime.subscribe((event) => events.push(event.type));
		const result = await runtime.run("call echo then finish");
		expect(result.status).toBe("completed");
		expect(mock.requests).toHaveLength(2);
		expect(events).toContain("tool_execution_end");
		expect(result.usage.total).toBeGreaterThan(0);
	});

	it.each(["session", "fast"] as const)(
		"does not make another provider request after %s cancellation",
		async (kind) => {
			const server = await pendingServer();
			const opts = await options(server.baseUrl);
			const runtime =
				kind === "session"
					? await createSessionRuntime(opts)
					: await createFastPathRuntime({
							...opts,
							spec: {
								...opts.spec,
								tools: ["search_policy", "get_clause_detail"],
								fastPath: {
									enabled: true,
									systemPrompt: "test",
									rewritePrompt: "rewrite",
									answerPrompt: "answer",
									maxClauses: 1,
									limits: { runTimeoutMs: 5000 },
								},
							},
						});
			cleanups.push(runtime.dispose);
			const running = runtime.run("q");
			await server.requestStarted;
			await runtime.abort();
			expect((await running).status).toBe("aborted");
			expect(server.calls()).toBe(1);
		},
	);
});
