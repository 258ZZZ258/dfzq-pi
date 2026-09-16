import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RunUsage } from "../runtime/contract.ts";
import { extractJsonBlock } from "../runtime/output-contract.ts";
import { type CreateSessionRuntimeOptions, createSessionRuntime } from "../runtime/session-runtime.ts";
import type { RuntimeSpec } from "../spec/types.ts";
import { ToolsetRegistry } from "../toolsets/registry.ts";
import type { NarrativeModelCall } from "./report-narrative-processing.ts";

export interface NarrativeModelOptions {
	profile: CreateSessionRuntimeOptions["profile"];
	registry: CreateSessionRuntimeOptions["registry"];
	/** Prompt paths must already have been resolved by the host's normal spec loader. */
	specs: Record<"rewrite" | "review", RuntimeSpec>;
	cwd: string;
	agentDir: string;
	deadlineAt: number;
	/** Shared with the parent report; runs exactly once before each model dispatch. */
	consumeModelTurn: () => void;
	authorizeExecution?: () => Promise<void>;
	assemblyTimeoutMs?: number;
}

/** Per-report caller, never shared across tasks. No direct provider client or hard-coded model. */
export function createNarrativeModelCaller(options: NarrativeModelOptions): {
	callModel: NarrativeModelCall;
	usage: () => RunUsage;
} {
	if (!Number.isFinite(options.deadlineAt)) throw new Error("Narrative model calls require a finite deadline");
	const usage: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	let busy = false;
	return {
		usage: () => ({ ...usage }),
		callModel: async (request, signal) => {
			signal.throwIfAborted();
			if (busy) throw new Error("Concurrent narrative calls are not supported");
			busy = true;
			try {
				const remainingMs = options.deadlineAt - Date.now();
				if (remainingMs <= 0) throw new Error("Narrative processing deadline exceeded");
				await options.authorizeExecution?.();
				const original = options.specs[request.phase];
				if (
					original.toolMode !== "none" ||
					original.tools.length ||
					original.skills?.length ||
					original.outputContract ||
					original.workflow ||
					original.fastPath
				)
					throw new Error("Narrative phases must be isolated tool-free sessions");
				const spec: RuntimeSpec = {
					...structuredClone(original),
					limits: {
						...original.limits,
						runTimeoutMs: Math.min(original.limits.runTimeoutMs ?? remainingMs, remainingMs),
					},
				};
				const toolsets = new ToolsetRegistry();
				toolsets.register(spec.toolset, async () => []);
				const suffix = `${request.phase}-${randomUUID()}`;
				const runtime = await createSessionRuntime({
					signal,
					assemblyTimeoutMs: options.assemblyTimeoutMs,
					authorizeExecution: options.authorizeExecution,
					consumeModelTurn: options.consumeModelTurn,
					spec,
					profile: options.profile,
					registry: options.registry,
					toolsets,
					cwd: join(options.cwd, suffix),
					agentDir: join(options.agentDir, suffix),
				});
				let abortWork: Promise<void> | undefined;
				const abort = () => {
					abortWork ??= runtime.abort();
					// Observe immediately; the original promise is awaited during cleanup below.
					void abortWork.catch(() => {});
				};
				signal.addEventListener("abort", abort, { once: true });
				try {
					signal.throwIfAborted();
					const result = await runtime.run(JSON.stringify(request));
					for (const key of Object.keys(usage) as Array<keyof RunUsage>) usage[key] += result.usage[key];
					signal.throwIfAborted();
					await options.authorizeExecution?.();
					if (result.status !== "completed") throw new Error(`Narrative phase ended with ${result.status}`);
					const parsed = extractJsonBlock(result.output ?? "");
					if (parsed.kind !== "ok") throw new Error("Narrative phase did not return JSON");
					return parsed.value;
				} finally {
					signal.removeEventListener("abort", abort);
					try {
						if (abortWork) await abortWork;
					} finally {
						await runtime.dispose();
					}
				}
			} finally {
				busy = false;
			}
		},
	};
}
