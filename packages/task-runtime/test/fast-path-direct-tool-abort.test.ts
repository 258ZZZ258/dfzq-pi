import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import {
	createFastPathRuntime,
	type FastPathRuntime,
	type FastPathRuntimeOptions,
} from "../src/runtime/fast-path-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createFauxHarness, type FauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

const SCHEMA = {
	type: "object",
	required: ["conclusion", "basis", "finish_reason", "confidence"],
	properties: {
		conclusion: { type: "string" },
		finish_reason: { enum: ["stop", "refused"] },
		confidence: { enum: ["high", "medium", "low"] },
		basis: {
			type: "array",
			items: { type: "object", required: ["clause_id"], properties: { clause_id: { type: "string" } } },
		},
	},
} as const;

const profile: ProviderProfile = {
	id: "test",
	baseUrl: "http://localhost/v1",
	apiKeyEnv: "TEST_KEY",
	api: "openai-completions",
	roles: {
		main: {
			provider: "faux",
			modelId: "faux",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	},
};

const searchParams = Type.Object({ query: Type.String() });
const detailParams = Type.Object({ clause_ids: Type.Array(Type.String()) });

function body(o: Record<string, unknown>): string {
	return `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
}

function rewriteReply(terms: string[]): string {
	return body({ queries: terms });
}

function answerReply(): string {
	return body({
		conclusion: "fixture conclusion",
		finish_reason: "stop",
		confidence: "high",
		basis: [{ clause_id: "C-1" }],
	});
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000, stepMs = 1): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

function hitsPayload(): string {
	return JSON.stringify({
		hits: [
			{
				clause_id: "C-1",
				text: null,
				score: 0.9,
				source_code: "S",
				source_doc_id: "D",
				corpus_type: "P-EXT",
				clause_path: "fixture",
			},
		],
		total: 1,
		text_available: false,
		_hint: "",
	});
}

function detailPayload(): string {
	return JSON.stringify({
		items: [
			{
				clause_id: "C-1",
				doc_title: "fixture document",
				clause_path: "fixture",
				status: "effective",
				source_code: "S",
				source_doc_id: "D",
				version: null,
				page_start: null,
				page_end: null,
				text: "fixture text",
			},
		],
		rejected: [],
		not_found: [],
	});
}

interface BlockingSearchRuntime {
	harness: FauxHarness;
	rt: FastPathRuntime;
	firstSearchStarted: Promise<void>;
	releaseFirstSearch: (payload: string) => void;
	firstSearchSignal: () => AbortSignal | undefined;
}

async function createBlockingSearchRuntime(runTimeoutMs?: number): Promise<BlockingSearchRuntime> {
	const harness = await createFauxHarness();
	harness.faux.setResponses([
		fauxAssistantMessage(rewriteReply(["fixture rewritten query"])),
		fauxAssistantMessage(answerReply()),
	]);

	const firstSearchStarted = deferred<void>();
	const firstSearchRelease = deferred<string>();
	let searchCalls = 0;
	let firstSearchSignal: AbortSignal | undefined;

	const searchTool: ToolDefinition<typeof searchParams> = {
		name: "search_policy",
		label: "search_policy",
		description: "synthetic search fixture",
		parameters: searchParams,
		execute: async (_toolCallId, _params, signal) => {
			searchCalls += 1;
			if (searchCalls === 1) {
				firstSearchSignal = signal;
				firstSearchStarted.resolve();
				if (signal) {
					if (signal.aborted) throw new Error("search aborted before start");
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("search aborted")), { once: true });
					});
				}
				const payload = await firstSearchRelease.promise;
				return { content: [{ type: "text", text: payload }], details: {} };
			}
			const payload = hitsPayload();
			return { content: [{ type: "text", text: payload }], details: {} };
		},
	};

	const detailTool: ToolDefinition<typeof detailParams> = {
		name: "get_clause_detail",
		label: "get_clause_detail",
		description: "synthetic detail fixture",
		parameters: detailParams,
		execute: async () => {
			const payload = detailPayload();
			return { content: [{ type: "text", text: payload }], details: {} };
		},
	};

	const toolsets = new ToolsetRegistry();
	toolsets.register("synthetic", async () => [searchTool, detailTool]);

	const spec: RuntimeSpec = {
		id: "pq",
		model: { role: "main" },
		toolset: "synthetic",
		tools: ["search_policy", "get_clause_detail"],
		limits: { runTimeoutMs: 60000 },
		fastPath: {
			enabled: true,
			systemPrompt: "system",
			rewritePrompt: "rewrite",
			answerPrompt: "answer",
			maxClauses: 3,
			limits: { runTimeoutMs: 60000, ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }) },
		},
	};

	const options: FastPathRuntimeOptions = {
		spec,
		profile,
		registry: createDefaultPluginRegistry(),
		toolsets,
		cwd: harness.cwd,
		agentDir: harness.agentDir,
		outputContractSchema: SCHEMA,
		modelOverride: { modelRuntime: harness.modelRuntime, model: harness.model },
	};

	const rt = await createFastPathRuntime(options);
	return {
		harness,
		rt,
		firstSearchStarted: firstSearchStarted.promise,
		releaseFirstSearch: firstSearchRelease.resolve,
		firstSearchSignal: () => firstSearchSignal,
	};
}

describe("FastPathRuntime direct tool cancellation", () => {
	it("passes a per-run AbortSignal to the head-start search and aborts it when runtime.abort() is called", async () => {
		const fixture = await createBlockingSearchRuntime();
		const runPromise = fixture.rt.runFast("original question");

		try {
			await fixture.firstSearchStarted;
			await fixture.rt.abort().catch(() => {});

			expect(fixture.firstSearchSignal()).toBeInstanceOf(AbortSignal);
			expect(fixture.firstSearchSignal()?.aborted).toBe(true);
		} finally {
			fixture.releaseFirstSearch(hitsPayload());
			await runPromise.catch(() => undefined);
			await fixture.rt.dispose();
			await fixture.harness.cleanup();
		}
	});

	it("aborts the head-start search signal when fastPath.runTimeoutMs fires", async () => {
		const fixture = await createBlockingSearchRuntime(20);
		const runPromise = fixture.rt.runFast("original question");

		try {
			await fixture.firstSearchStarted;

			expect(fixture.firstSearchSignal()).toBeInstanceOf(AbortSignal);
			await waitUntil(() => fixture.firstSearchSignal()?.aborted === true);

			const got = await runPromise;
			expect(got.verdict.accept).toBe(false);
			expect(got.result.status).toBe("limit_exceeded");
			expect(got.result.limit).toBe("runTimeout");
		} finally {
			fixture.releaseFirstSearch(hitsPayload());
			await runPromise.catch(() => undefined);
			await fixture.rt.dispose();
			await fixture.harness.cleanup();
		}
	});
});
