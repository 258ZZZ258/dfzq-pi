import { GrantLease } from "../auth/lease.ts";
import { SessionInbox } from "../interaction/inbox.ts";
import { createHttpEmbedder } from "../memory/embedding.ts";
import { MemoryService } from "../memory/service.ts";
import type { Runtime } from "../runtime/contract.ts";
import { createDefaultRuntimeFactory } from "../server/main.ts";
import type { RuntimeFactory } from "../server/run-manager.ts";
import { createPostgresStateStore } from "../state/postgres.ts";
import { createSqliteStateStore, type StateStore } from "../state/store.ts";
import { ToolLedger } from "../state/tool-ledger.ts";
import { type WorkerMessage, workerMessage } from "./protocol.ts";
import type { WorkerConfig } from "./runtime.ts";

let runtime: Runtime | undefined;
let stateStore: StateStore | undefined;
let checkpointId = -1;
const checkpoints = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
const send = (message: WorkerMessage) => {
	if (process.connected && workerMessage(message)) process.send?.(message);
};
process.on("message", (raw) => {
	if (!workerMessage(raw) || typeof raw.id !== "number") return;
	if (raw.method === "checkpoint_ack") {
		const pending = checkpoints.get(raw.id);
		checkpoints.delete(raw.id);
		if (raw.error) pending?.reject(new Error(raw.error));
		else pending?.resolve();
		return;
	}
	void (async () => {
		try {
			let result: unknown;
			if (raw.method === "init") {
				if (runtime) throw new Error("worker_already_initialized");
				const payload = raw.payload as {
					config: WorkerConfig;
					input: Parameters<RuntimeFactory>[0];
					checkpointEnabled?: boolean;
				};
				stateStore =
					payload.config.state?.kind === "sqlite"
						? createSqliteStateStore(payload.config.state.path)
						: payload.config.state?.kind === "postgres"
							? createPostgresStateStore(process.env[payload.config.state.dsnEnv] ?? "")
							: undefined;
				const factory = await createDefaultRuntimeFactory({
					grantLeases: stateStore ? new GrantLease(stateStore) : undefined,
					inbox: stateStore ? new SessionInbox(stateStore) : undefined,
					memory: stateStore
						? new MemoryService(stateStore, {
								embedder: payload.config.embedding
									? createHttpEmbedder({
											baseUrl: payload.config.embedding.baseUrl,
											model: payload.config.embedding.model,
											apiKey: payload.config.embedding.apiKeyEnv
												? process.env[payload.config.embedding.apiKeyEnv]
												: undefined,
										})
									: undefined,
							})
						: undefined,
					...payload.config,
					toolLedger: stateStore ? new ToolLedger(stateStore) : undefined,
				});
				runtime = await factory({
					...payload.input,
					onCheckpoint: payload.checkpointEnabled
						? (snapshot) =>
								new Promise<void>((resolve, reject) => {
									const id = checkpointId--;
									checkpoints.set(id, { resolve, reject });
									send({ version: 1, id, method: "checkpoint", payload: snapshot });
								})
						: undefined,
				});
				runtime.subscribe((event) => send({ version: 1, event }));
				result = {
					id: runtime.id,
					specId: runtime.specId,
					sessionId: runtime.sessionId,
					snapshot: runtime.snapshot(),
				};
			} else {
				if (!runtime) throw new Error("worker_not_initialized");
				const payload = raw.payload as { input?: string; runId?: string } | undefined;
				switch (raw.method) {
					case "getConversation":
						if (!runtime.getConversation) throw new Error("conversation_not_supported");
						result = await runtime.getConversation();
						break;
					case "run":
						result = await runtime.run(payload?.input ?? "", { runId: payload?.runId });
						break;
					case "abort":
						await runtime.abort();
						break;
					case "steer":
						await runtime.steer(payload?.input ?? "");
						break;
					case "followUp":
						await runtime.followUp(payload?.input ?? "");
						break;
					case "waitForIdle":
						await runtime.waitForIdle();
						break;
					case "dispose":
						try {
							await runtime.dispose();
						} finally {
							await stateStore?.close();
						}
						break;
					default:
						throw new Error("worker_unknown_method");
				}
			}
			send({ version: 1, id: raw.id, result });
		} catch (error) {
			send({ version: 1, id: raw.id, error: error instanceof Error ? error.message : "worker_error" });
		}
	})();
});
