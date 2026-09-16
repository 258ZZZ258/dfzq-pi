import { hashState } from "../state/json.ts";
import type { RunUsage, SourceDetail } from "./contract.ts";

export interface SessionCheckpoint {
	checksum?: string;
	version: 1;
	kind: "pi-session";
	piVersion: "0.82.1";
	runId: string;
	specId: string;
	configHash: string;
	input: string;
	turns: number;
	next: "pending_tools" | "continue" | "judge" | "repair";
	sessionJsonl: string;
	messages: unknown[];
	clauseIds: string[];
	sourceDetails: SourceDetail[];
	usage: RunUsage;
	pluginState?: Record<string, unknown>;
}

export function validateCheckpoint(value: SessionCheckpoint, configHash: string, specId: string): void {
	if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
		throw new Error("checkpoint_incompatible");
	const copy = { ...value };
	delete copy.checksum;
	if (value.checksum !== hashState(copy)) throw new Error("checkpoint_integrity_mismatch");
	if (
		value.version !== 1 ||
		value.kind !== "pi-session" ||
		value.piVersion !== "0.82.1" ||
		value.configHash !== configHash ||
		value.specId !== specId ||
		!Number.isInteger(value.turns) ||
		value.turns < 0 ||
		!Array.isArray(value.messages) ||
		!Array.isArray(value.clauseIds) ||
		!Array.isArray(value.sourceDetails) ||
		!["pending_tools", "continue", "judge", "repair"].includes(value.next) ||
		typeof value.sessionJsonl !== "string" ||
		Buffer.byteLength(value.sessionJsonl) > 8 * 1024 * 1024
	)
		throw new Error("checkpoint_incompatible");
}
