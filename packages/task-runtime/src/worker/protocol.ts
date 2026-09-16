export const MAX_WORKER_MESSAGE_BYTES = 8 * 1024 * 1024;
export interface WorkerMessage {
	version: 1;
	id?: number;
	method?: string;
	payload?: unknown;
	result?: unknown;
	error?: string;
	event?: unknown;
}
export function workerMessage(value: unknown): value is WorkerMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as WorkerMessage).version === 1 &&
		Buffer.byteLength(JSON.stringify(value)) <= MAX_WORKER_MESSAGE_BYTES
	);
}
