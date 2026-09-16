import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryService } from "../src/memory/service.ts";
import { Gate } from "../src/server/gate.ts";
import { CheckpointCoordinator } from "../src/state/checkpoints.ts";
import { createSqliteStateStore } from "../src/state/store.ts";

// Local capacity probe only: no model, network, credentials, or production database.
const root = await mkdtemp(join(tmpdir(), "pi-capacity-"));
const state = createSqliteStateStore(join(root, "state.db"));
const stats = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)], maxMs: sorted.at(-1) };
};
try {
	const startRss = process.memoryUsage().rss;
	const memory = new MemoryService(state);
	const scope = { tenantId: "probe", userId: "probe" };
	const writes: number[] = [];
	for (let i = 0; i < 200; i++) {
		const start = performance.now();
		await memory.propose(scope, { text: `架构记忆 ${i} 检查点恢复 ` + "示例内容".repeat(100), category: "fact", source: "user", sourceRef: "local-capacity-probe" }, `write-${i}`);
		writes.push(performance.now() - start);
	}
	let rejected = false;
	try { await memory.propose(scope, { text: "overflow", category: "fact", source: "user", sourceRef: "probe" }, "overflow"); }
	catch (error) { rejected = error instanceof Error && error.message === "memory_capacity_exceeded"; }
	if (!rejected) throw new Error("capacity bound was not enforced");
	const retrievals: number[] = [];
	let largestContext = 0;
	for (let i = 0; i < 100; i++) {
		const start = performance.now();
		const selected = await memory.retrieve(scope, "架构记忆 检查点恢复", { limit: 20, maxChars: 3000 });
		retrievals.push(performance.now() - start);
		largestContext = Math.max(largestContext, selected.reduce((n, entry) => n + entry.text.length, 0));
	}
	const lease = await new CheckpointCoordinator(state).acquire({ scope: "probe", runId: "checkpoint", fingerprint: "probe-v1" });
	const checkpointTimes: number[] = [];
	const payload = { version: 1, text: "x".repeat(256 * 1024) };
	for (let i = 0; i < 100; i++) { const start = performance.now(); await lease.save(payload); checkpointTimes.push(performance.now() - start); }
	await lease.release("paused");
	const gate = new Gate();
	const admissions = Array.from({ length: 1000 }, (_, i) => gate.tryAcquire(`session-${i}`));
	const counts = { admitted: 0, queued: 0, rejected: 0 };
	for (const admission of admissions) {
		if (admission.kind === "admitted") counts.admitted++;
		else if (admission.kind === "queued") { counts.queued++; void admission.ticket.catch(() => {}); admission.cancel(); }
		else counts.rejected++;
	}
	for (const admission of admissions) if (admission.kind === "admitted") admission.ticket.release();
	console.log(JSON.stringify({ measuredAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }, backend: "local SQLite WAL; no embeddings/model", memory: { entries: 200, capacityRejected: rejected, writes: stats(writes), retrievals: stats(retrievals), maxSelectedChars: largestContext }, checkpoint: { bytes: Buffer.byteLength(JSON.stringify(payload)), save: stats(checkpointTimes) }, gate: { simultaneousAttempts: 1000, ...counts, finalActive: gate.activeCount, finalQueued: gate.queueDepth }, rss: { beforeBytes: startRss, afterBytes: process.memoryUsage().rss }, limitation: "Single process synthetic probe; not a production SLO, peak RSS measurement or PostgreSQL benchmark." }, null, 2));
} finally { await state.close(); await rm(root, { recursive: true, force: true }); }
