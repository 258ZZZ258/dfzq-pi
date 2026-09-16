import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime, RunUsage } from "../runtime/contract.ts";
import { sealDelivery } from "../runtime/delivery.ts";
import { type CreateSessionRuntimeOptions, createSessionRuntime } from "../runtime/session-runtime.ts";
import type { RuntimeSpec } from "../spec/types.ts";
import type { ToolsetRegistry } from "../toolsets/registry.ts";
import { auditReportDelivery } from "./report-delivery.ts";
import { createNarrativeModelCaller } from "./report-narrative-model.ts";
import { processReportNarratives, type ReportNarrativeProcessor } from "./report-narrative-processing.ts";

/** Task-owned composition: all model sessions still use the normal runtime assembly chain. */
export async function createAuditReportRuntime(
	options: Omit<CreateSessionRuntimeOptions, "toolsets" | "beforeRun" | "resolveOutput"> & {
		buildToolsets: (processor: ReportNarrativeProcessor) => ToolsetRegistry;
		narrativeSpecs: Record<"rewrite" | "review", RuntimeSpec>;
	},
): Promise<Runtime> {
	const { runTimeoutMs, maxTurns } = options.spec.limits;
	if (!runTimeoutMs || !Number.isFinite(runTimeoutMs) || !Number.isInteger(maxTurns) || !maxTurns || maxTurns < 1)
		throw new Error("Audit narrative runtime requires a deadline and positive maxTurns");
	if (options.resume || options.onCheckpoint || options.interaction)
		throw new Error("Report draft state does not support durable session recovery");
	let modelTurns = 0;
	let turnLimitExceeded = false;
	const consumeModelTurn = () => {
		if (modelTurns >= maxTurns) {
			turnLimitExceeded = true;
			active?.controller.abort(new Error("maxTurns"));
			throw new Error("maxTurns");
		}
		options.consumeModelTurn?.();
		modelTurns++;
	};
	let active:
		| {
				controller: AbortController;
				caller: ReturnType<typeof createNarrativeModelCaller>;
				recordDirectory: string;
				runId: string;
				recordFiles: Array<{ name: string; sha256: string }>;
		  }
		| undefined;
	const main = await createSessionRuntime({
		...options,
		...auditReportDelivery,
		consumeModelTurn,
		toolsets: options.buildToolsets(async (dataset, draft) => {
			if (!active) throw new Error("Narrative processing requires an active report run");
			const current = active;
			const processed = await processReportNarratives(dataset, draft, {
				callModel: active.caller.callModel,
				signal: active.controller.signal,
			});
			current.controller.signal.throwIfAborted();
			// Private run artifacts, not model-visible content or a frontend confidence score.
			// Persist before delivery; never claim an accepted rewrite without its verification record.
			await mkdir(current.recordDirectory, { recursive: true });
			const recordName = `${randomUUID()}.json`;
			const recordJson = JSON.stringify({
				schemaVersion: "audit-narrative-review.v1",
				runId: current.runId,
				taskId: dataset.task.taskId,
				records: processed.records,
			});
			await writeFile(join(current.recordDirectory, recordName), recordJson, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			current.recordFiles.push({ name: recordName, sha256: createHash("sha256").update(recordJson).digest("hex") });
			current.controller.signal.throwIfAborted();
			return processed;
		}),
	});
	return {
		id: main.id,
		specId: main.specId,
		sessionId: main.sessionId,
		async run(input, runOptions) {
			if (active) throw new Error("Report runtime already has an active run");
			modelTurns = 0;
			turnLimitExceeded = false;
			options.signal?.throwIfAborted();
			const startedAt = Date.now();
			const reportRunId = runOptions?.runId ?? randomUUID();
			const controller = new AbortController();
			const caller = createNarrativeModelCaller({
				profile: options.profile,
				registry: options.registry,
				specs: options.narrativeSpecs,
				cwd: options.cwd,
				agentDir: options.agentDir,
				deadlineAt: startedAt + runTimeoutMs,
				consumeModelTurn,
				authorizeExecution: options.authorizeExecution,
				assemblyTimeoutMs: options.assemblyTimeoutMs,
			});
			active = {
				controller,
				caller,
				runId: reportRunId,
				recordDirectory: join(options.agentDir, "narrative-review", randomUUID()),
				recordFiles: [],
			};
			let timedOut = false;
			const cancel = () => {
				controller.abort(options.signal?.reason);
				void main.abort().catch(() => {});
			};
			options.signal?.addEventListener("abort", cancel, { once: true });
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				void main.abort().catch(() => {});
			}, runTimeoutMs);
			try {
				const result = await main.run(input, { ...runOptions, runId: reportRunId });
				const additional = caller.usage();
				for (const key of Object.keys(additional) as Array<keyof RunUsage>) result.usage[key] += additional[key];
				result.durationMs = Date.now() - startedAt;
				result.turns = modelTurns;
				const limit = timedOut ? "runTimeout" : turnLimitExceeded ? "maxTurns" : result.limit;
				if (limit) {
					result.status = "limit_exceeded";
					result.limit = limit;
				} else if (controller.signal.aborted) result.status = "aborted";
				if (result.status !== "completed") {
					delete result.answer;
					delete result.sourceDetails;
				}
				await mkdir(active.recordDirectory, { recursive: true });
				await writeFile(
					join(active.recordDirectory, "manifest.json"),
					JSON.stringify({
						schemaVersion: "audit-narrative-manifest.v1",
						runId: reportRunId,
						status: result.status,
						outputSha256:
							result.output === undefined ? null : createHash("sha256").update(result.output).digest("hex"),
						records: active.recordFiles,
						usage: result.usage,
					}),
					{ encoding: "utf8", flag: "wx", mode: 0o600 },
				);
				return sealDelivery(result, result.delivery?.validation ?? "not_checked", result.delivery?.schemaHash);
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", cancel);
				active = undefined;
			}
		},
		steer: (text) => main.steer(text),
		followUp: (text) => main.followUp(text),
		async abort() {
			active?.controller.abort();
			await main.abort();
		},
		waitForIdle: () => main.waitForIdle(),
		subscribe: (listener) => main.subscribe(listener),
		get isIdle() {
			return !active && main.isIdle;
		},
		get lastActiveAt() {
			return main.lastActiveAt;
		},
		snapshot: () => main.snapshot(),
		async dispose() {
			active?.controller.abort();
			await main.abort();
			await main.dispose();
		},
	};
}
