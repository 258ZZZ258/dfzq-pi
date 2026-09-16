import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Conversation } from "../interaction/inbox.ts";
import type { RunResult, Runtime, RuntimeEvent, RuntimeSnapshot } from "../runtime/contract.ts";
import type { RuntimeFactory } from "../server/run-manager.ts";
import { workerMessage } from "./protocol.ts";

export interface WorkerConfig {
	auditReportSources?: { apiBaseUrl: string; operatingWorkbookPath: string };
	embedding?: { baseUrl: string; model: string; apiKeyEnv?: string };
	state?: { kind: "sqlite"; path: string } | { kind: "postgres"; dsnEnv: string };
	profilePath: string;
	specsDir: string;
	workRoot: string;
}
export interface WorkerOptions {
	env: Record<string, string>;
	assemblyTimeoutMs?: number;
	runTimeoutMs?: number;
	stopGraceMs?: number;
	entryPath?: string;
}

export async function createWorkerRuntime(
	config: WorkerConfig,
	input: Parameters<RuntimeFactory>[0],
	options: WorkerOptions,
): Promise<Runtime & { workerPid: number }> {
	if (process.platform === "win32") throw new Error("worker process-group isolation requires a POSIX host");
	input.signal?.throwIfAborted();
	const stopGrace = options.stopGraceMs ?? 2000;
	for (const value of [stopGrace, options.assemblyTimeoutMs ?? 60000, options.runTimeoutMs ?? 900000])
		if (!Number.isFinite(value) || value <= 0) throw new Error("worker timeouts must be positive");
	const child = fork(
		fileURLToPath(new URL("./guardian.ts", import.meta.url)),
		[options.entryPath ?? fileURLToPath(new URL("./entry.ts", import.meta.url))],
		{
			detached: true,
			execArgv: ["--experimental-strip-types"],
			env: options.env,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		},
	);
	if (!child.pid) throw new Error("worker_spawn_failed");
	const workerPid = child.pid;
	const pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let eventSequence = 0;
	let nextId = 1,
		closed = false,
		active = false,
		lastActiveAt = Date.now(),
		reason = "worker_exited";
	let disposePromise: Promise<void> | undefined;
	let exit!: () => void;
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	const kill = (why: string) => {
		reason = why;
		try {
			process.kill(-workerPid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	const finish = () => {
		closed = true;
		const event: RuntimeEvent = {
			type: "worker_terminated",
			runId: input.runId,
			specId: input.specId,
			seq: eventSequence++,
			ts: Date.now(),
			payload: { reason },
		};
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {}
		}
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		pending.clear();
		exit();
	};
	child.on("exit", finish);
	child.on("error", () => {
		kill("worker_spawn_failed");
		finish();
	});
	child.on("message", (message) => {
		if (!workerMessage(message)) {
			kill("worker_protocol_error");
			return;
		}
		if (message.method === "checkpoint" && typeof message.id === "number") {
			void (async () => {
				let error: string | undefined;
				try {
					if (!input.onCheckpoint) throw new Error("checkpoint_sink_missing");
					await input.onCheckpoint(message.payload as Parameters<NonNullable<typeof input.onCheckpoint>>[0]);
				} catch (cause) {
					error = cause instanceof Error ? cause.message : "checkpoint_persistence_failed";
				}
				if (child.connected)
					child.send({ version: 1, id: message.id, method: "checkpoint_ack", error }, (sendError) => {
						if (sendError) kill("worker_transport_failed");
					});
			})();
			return;
		}
		if (message.event) {
			const event = message.event as RuntimeEvent;
			if (Number.isInteger(event.seq)) eventSequence = Math.max(eventSequence, event.seq + 1);
			for (const listener of listeners) {
				try {
					listener(message.event as RuntimeEvent);
				} catch {
					/* isolate observers */
				}
			}
			return;
		}
		if (typeof message.id !== "number") return;
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) entry.reject(new Error(message.error));
		else entry.resolve(message.result);
	});
	const request = (method: string, payload: unknown, timeout: number, timeoutReason = "worker_timeout") =>
		new Promise<unknown>((resolve, reject) => {
			if (closed || !child.connected) {
				reject(new Error(reason));
				return;
			}
			const id = nextId++;
			const message = { version: 1 as const, id, method, payload };
			if (!workerMessage(message)) {
				reject(new Error("worker_message_too_large"));
				return;
			}
			const timer = setTimeout(() => kill(timeoutReason), timeout);
			pending.set(id, { resolve, reject, timer });
			child.send(message, (error) => {
				if (error) kill("worker_transport_failed");
			});
		});
	const onAbort = () => kill("worker_cancelled");
	input.signal?.addEventListener("abort", onAbort, { once: true });
	let meta: { id: string; specId: string; sessionId: string; snapshot: RuntimeSnapshot };
	try {
		const wireInput = { ...input, signal: undefined, onCheckpoint: undefined };
		meta = (await request(
			"init",
			{ config, input: wireInput, checkpointEnabled: Boolean(input.onCheckpoint) },
			options.assemblyTimeoutMs ?? 60000,
			"assembly_timeout",
		)) as typeof meta;
		if (!meta || typeof meta.id !== "string" || meta.specId !== input.specId || typeof meta.sessionId !== "string")
			throw new Error("worker_protocol_error");
	} catch (error) {
		kill("worker_initialization_failed");
		await exited;
		throw error;
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
	}
	return {
		getConversation: async () => (await request("getConversation", undefined, stopGrace)) as Conversation,
		workerPid,
		id: meta.id,
		specId: meta.specId,
		sessionId: meta.sessionId,
		async run(text, opts) {
			if (active) throw new Error("worker_run_in_progress");
			active = true;
			const started = Date.now();
			try {
				return (await request(
					"run",
					{ input: text, runId: opts?.runId ?? input.runId },
					options.runTimeoutMs ?? 900000,
				)) as RunResult;
			} catch (error) {
				if (!closed) throw error;
				return {
					runId: opts?.runId ?? input.runId,
					specId: input.specId,
					status:
						reason === "worker_cancelled" ? "aborted" : reason === "worker_timeout" ? "limit_exceeded" : "error",
					...(reason === "worker_timeout" ? { limit: "runTimeout" as const } : {}),
					errorMessage: `${reason}; in-flight usage unavailable`,
					turns: 0,
					durationMs: Date.now() - started,
					judgeAttempts: {},
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					telemetryIncomplete: true,
				};
			} finally {
				active = false;
				lastActiveAt = Date.now();
			}
		},
		async abort() {
			if (closed) return;
			try {
				await request("abort", undefined, stopGrace, "worker_cancelled");
			} catch {
				if (!closed) kill("worker_cancelled");
				await exited;
			}
		},
		async steer(text) {
			await request("steer", { input: text }, stopGrace);
		},
		async followUp(text) {
			await request("followUp", { input: text }, stopGrace);
		},
		async waitForIdle() {
			if (!closed) await request("waitForIdle", undefined, options.runTimeoutMs ?? 900000);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get isIdle() {
			return !active;
		},
		get lastActiveAt() {
			return lastActiveAt;
		},
		snapshot: () => meta.snapshot,
		dispose() {
			disposePromise ??= (async () => {
				if (!closed) {
					try {
						await request("dispose", undefined, stopGrace, "worker_disposed");
					} finally {
						kill("worker_disposed");
						await exited;
					}
				}
				listeners.clear();
			})();
			return disposePromise;
		},
	};
}
