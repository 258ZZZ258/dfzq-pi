import { randomUUID } from "node:crypto";
import { hashState } from "../state/json.ts";
import type { StateStore } from "../state/store.ts";

export interface MemoryScope {
	tenantId: string;
	userId: string;
	sessionId?: string;
}
export interface MemoryInput {
	text: string;
	category: "fact" | "preference" | "summary";
	source: "user" | "tool" | "model";
	sourceRef: string;
	conflictKey?: string;
	expiresAt?: number;
}
export interface MemoryEntry extends MemoryInput {
	id: string;
	requestKey: string;
	revision: number;
	fingerprint: string;
	status: "candidate" | "active" | "superseded" | "deleted";
	createdAt: number;
	updatedAt: number;
	supersededBy?: string;
	dependencies?: Array<{ id: string; hash: string }>;
	embedding?: { model: string; values: number[] };
}
export interface Embedder {
	id: string;
	embed(text: string): Promise<number[]>;
}
interface Bucket {
	version: 1;
	entries: MemoryEntry[];
}

function key(scope: MemoryScope): string {
	if (!scope.tenantId || !scope.userId) throw new Error("memory_scope_required");
	return JSON.stringify(["memory", scope.tenantId, scope.userId, scope.sessionId ?? null]);
}
function contentHash(entry: MemoryEntry): string {
	return hashState({ text: entry.text, category: entry.category, sourceRef: entry.sourceRef });
}
function current(entry: MemoryEntry, entries: MemoryEntry[], now: number, seen = new Set<string>()): boolean {
	if (seen.has(entry.id) || entry.status === "deleted" || (entry.expiresAt !== undefined && entry.expiresAt <= now))
		return false;
	seen.add(entry.id);
	return (entry.dependencies ?? []).every((dep) => {
		const parent = entries.find((e) => e.id === dep.id);
		return (
			parent &&
			contentHash(parent) === dep.hash &&
			(parent.status === "active" || parent.supersededBy === entry.id) &&
			current(parent, entries, now, new Set(seen))
		);
	});
}
function tokens(text: string): Set<string> {
	const chars = Array.from(text.toLowerCase().replace(/\s+/g, ""));
	return new Set([
		...(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
		...chars.slice(1).map((c, i) => chars[i] + c),
	]);
}
function vectorValid(values: number[]): boolean {
	return (
		Array.isArray(values) &&
		values.length > 0 &&
		values.length <= 4096 &&
		values.every((n) => typeof n === "number" && Number.isFinite(n))
	);
}
function cosine(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
	const denominator = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) * b.reduce((sum, v) => sum + v * v, 0));
	return denominator ? Math.max(0, dot / denominator) : 0;
}

/** Caller scope must come from authenticated host context, never model-generated arguments. */
export class MemoryService {
	private readonly store: StateStore;
	private readonly now: () => number;
	private readonly capacity: number;
	private readonly embedder?: Embedder;
	constructor(store: StateStore, options: { now?: () => number; capacity?: number; embedder?: Embedder } = {}) {
		this.store = store;
		this.now = options.now ?? Date.now;
		this.capacity = options.capacity ?? 200;
		this.embedder = options.embedder;
		if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 10000)
			throw new Error("memory_capacity_invalid");
	}
	async list(scope: MemoryScope): Promise<MemoryEntry[]> {
		const rec = await this.store.get(key(scope));
		if (!rec) return [];
		const bucket = rec.value as Bucket;
		if (bucket?.version !== 1 || !Array.isArray(bucket.entries)) throw new Error("memory_version_unsupported");
		return bucket.entries;
	}
	async assertCurrent(scope: MemoryScope, id: string, revision: number): Promise<void> {
		const entries = await this.list(scope);
		const entry = entries.find((e) => e.id === id);
		if (!entry || entry.status !== "active" || entry.revision !== revision || !current(entry, entries, this.now()))
			throw new Error("checkpoint_memory_stale");
	}
	private async mutate<T>(scope: MemoryScope, operation: (entries: MemoryEntry[]) => T): Promise<T> {
		const storageKey = key(scope);
		for (let attempt = 0; attempt < 8; attempt++) {
			const rec = await this.store.get(storageKey);
			const bucket = rec?.value as Bucket | undefined;
			if (bucket && (bucket.version !== 1 || !Array.isArray(bucket.entries)))
				throw new Error("memory_version_unsupported");
			const entries = bucket?.entries ?? [];
			const result = operation(entries);
			if (await this.store.compareAndSwap(storageKey, rec?.revision ?? null, { version: 1, entries })) return result;
		}
		throw new Error("memory_busy");
	}
	async propose(scope: MemoryScope, input: MemoryInput, requestId: string): Promise<MemoryEntry> {
		return this.create(scope, input, requestId);
	}
	private async create(
		scope: MemoryScope,
		input: MemoryInput,
		requestId: string,
		dependencies?: MemoryEntry["dependencies"],
	): Promise<MemoryEntry> {
		key(scope);
		if (
			!requestId ||
			typeof input.text !== "string" ||
			!input.text.trim() ||
			input.text.length > 4000 ||
			!["fact", "preference", "summary"].includes(input.category) ||
			!["user", "tool", "model"].includes(input.source) ||
			typeof input.sourceRef !== "string" ||
			input.sourceRef.length > 1000
		)
			throw new Error("memory_input_invalid");
		if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.now()))
			throw new Error("memory_expiry_invalid");
		if (
			input.conflictKey !== undefined &&
			(typeof input.conflictKey !== "string" || !input.conflictKey || input.conflictKey.length > 256)
		)
			throw new Error("memory_conflict_key_invalid");
		const id = randomUUID();
		const requestKey = hashState([key(scope), requestId]);
		const fingerprint = hashState(JSON.parse(JSON.stringify({ ...input, dependencies: dependencies ?? [] })));
		let embedding: MemoryEntry["embedding"];
		if (this.embedder) {
			try {
				const values = await this.embedder.embed(input.text);
				if (vectorValid(values)) embedding = { model: this.embedder.id, values };
			} catch {
				/* lexical retrieval remains available */
			}
		}
		return this.mutate(scope, (entries) => {
			const old = entries.find((e) => e.requestKey === requestKey);
			if (old) {
				if (old.fingerprint !== fingerprint) throw new Error("memory_idempotency_conflict");
				return old;
			}
			if (entries.length >= this.capacity) throw new Error("memory_capacity_exceeded");
			const entry: MemoryEntry = {
				...input,
				id,
				requestKey,
				fingerprint,
				revision: 1,
				status: input.source === "user" ? "active" : "candidate",
				createdAt: this.now(),
				updatedAt: this.now(),
				...(dependencies ? { dependencies } : {}),
				...(embedding ? { embedding } : {}),
			};
			if (entry.status === "active") this.supersede(entries, entry);
			entries.push(entry);
			return entry;
		});
	}
	private supersede(entries: MemoryEntry[], replacement: MemoryEntry): void {
		for (const entry of entries)
			if (
				entry.status === "active" &&
				((replacement.conflictKey && replacement.conflictKey === entry.conflictKey) ||
					replacement.dependencies?.some((d) => d.id === entry.id))
			) {
				entry.status = "superseded";
				entry.supersededBy = replacement.id;
				entry.revision++;
				entry.updatedAt = this.now();
			}
	}
	async approve(scope: MemoryScope, id: string, revision: number): Promise<MemoryEntry> {
		return this.mutate(scope, (entries) => {
			const entry = entries.find((e) => e.id === id);
			if (!entry || entry.revision !== revision) throw new Error("memory_revision_conflict");
			if (entry.status !== "candidate" || (entry.expiresAt !== undefined && entry.expiresAt <= this.now()))
				throw new Error("memory_not_approvable");
			for (const dep of entry.dependencies ?? []) {
				const source = entries.find((e) => e.id === dep.id);
				if (
					!source ||
					source.status !== "active" ||
					!current(source, entries, this.now()) ||
					contentHash(source) !== dep.hash
				)
					throw new Error("memory_summary_stale");
			}
			entry.status = "active";
			entry.revision++;
			entry.updatedAt = this.now();
			this.supersede(
				entries.filter((e) => e.id !== id),
				entry,
			);
			return entry;
		});
	}
	async revise(
		scope: MemoryScope,
		id: string,
		revision: number,
		text: string,
		sourceRef: string,
	): Promise<MemoryEntry> {
		if (!text.trim() || text.length > 4000 || sourceRef.length > 1000) throw new Error("memory_input_invalid");
		return this.mutate(scope, (entries) => {
			const entry = entries.find((e) => e.id === id);
			if (!entry || entry.revision !== revision) throw new Error("memory_revision_conflict");
			if (!["candidate", "active"].includes(entry.status)) throw new Error("memory_not_editable");
			entry.text = text;
			entry.sourceRef = sourceRef;
			entry.source = "user";
			entry.status = "active";
			entry.revision++;
			entry.updatedAt = this.now();
			delete entry.embedding;
			this.supersede(
				entries.filter((e) => e.id !== id),
				entry,
			);
			return entry;
		});
	}
	async remove(scope: MemoryScope, id: string, revision: number): Promise<void> {
		return this.mutate(scope, (entries) => {
			const target = entries.find((e) => e.id === id);
			if (!target || target.revision !== revision) throw new Error("memory_revision_conflict");
			const removed = new Set([id]);
			for (let i = 0; i < entries.length; i++)
				for (const entry of entries) if (entry.dependencies?.some((d) => removed.has(d.id))) removed.add(entry.id);
			for (const entry of entries)
				if (removed.has(entry.id)) {
					entry.status = "deleted";
					entry.text = "";
					entry.sourceRef = "";
					delete entry.embedding;
					entry.revision++;
					entry.updatedAt = this.now();
				}
		});
	}
	async compact(scope: MemoryScope, ids: string[], summary: string, requestId: string): Promise<MemoryEntry> {
		const entries = await this.list(scope);
		if (!ids.length || new Set(ids).size !== ids.length) throw new Error("memory_summary_inputs_invalid");
		const dependencies = ids.map((id) => {
			const entry = entries.find((e) => e.id === id && e.status === "active");
			if (!entry || !current(entry, entries, this.now())) throw new Error("memory_summary_inputs_invalid");
			return { id, hash: contentHash(entry) };
		});
		return this.create(
			scope,
			{ text: summary, category: "summary", source: "model", sourceRef: "compaction" },
			requestId,
			dependencies,
		);
	}
	async prune(scope: MemoryScope, retentionMs = 30 * 86400000): Promise<number> {
		if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error("memory_retention_invalid");
		return this.mutate(scope, (entries) => {
			const before = entries.length;
			const kept = entries.filter(
				(e) =>
					!(e.status === "deleted" && this.now() - e.updatedAt >= retentionMs) &&
					!(e.expiresAt !== undefined && this.now() - e.expiresAt >= retentionMs),
			);
			entries.splice(0, entries.length, ...kept);
			return before - kept.length;
		});
	}
	async retrieve(
		scope: MemoryScope,
		query: string,
		options: { limit?: number; maxChars?: number } = {},
	): Promise<Array<MemoryEntry & { score: number }>> {
		const entries = await this.list(scope);

		const queryTokens = tokens(query);
		let vector: number[] | undefined;
		if (this.embedder) {
			try {
				const values = await this.embedder.embed(query);
				if (vectorValid(values)) vector = values;
			} catch {
				/* fall back to lexical scores */
			}
		}
		const ranked = entries
			.filter((entry) => entry.status === "active" && current(entry, entries, this.now()))
			.map((entry) => {
				const textTokens = tokens(entry.text);
				const lexical =
					[...queryTokens].filter((token) => textTokens.has(token)).length / Math.max(1, queryTokens.size);
				const embedding = entry.embedding;
				const semantic =
					vector && embedding && embedding.model === this.embedder?.id ? cosine(vector, embedding.values) : 0;
				return { ...entry, score: lexical + semantic + (entry.category === "preference" ? 0.01 : 0) };
			})
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
		const latest = await this.list(scope);
		const selected: Array<MemoryEntry & { score: number }> = [];
		let chars = 0;
		for (const entry of ranked) {
			if (selected.length >= Math.max(0, Math.min(20, options.limit ?? 6))) break;
			const latestEntry = latest.find(
				(e) => e.id === entry.id && e.revision === entry.revision && e.status === "active",
			);
			if (!latestEntry || !current(latestEntry, latest, this.now())) continue;
			if (chars + entry.text.length > Math.max(0, Math.min(12000, options.maxChars ?? 3000))) continue;
			selected.push(entry);
			chars += entry.text.length;
		}
		return selected;
	}
}
