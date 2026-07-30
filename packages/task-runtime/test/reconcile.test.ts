import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcile } from "../src/observability/reconcile.ts";

let root: string;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(piTools: string[], mcpTools: string[]) {
	root = await mkdtemp(join(tmpdir(), "recon-"));
	const trajectory = join(root, "trajectory.jsonl");
	const toolLog = join(root, "tool_calls.jsonl");
	await writeFile(
		trajectory,
		piTools
			.map((tool, i) =>
				JSON.stringify({
					runId: "r1",
					specId: "s1",
					seq: i,
					ts: i,
					type: "tool_execution_end",
					payload: { toolName: tool },
				}),
			)
			.join("\n"),
	);
	await writeFile(
		toolLog,
		mcpTools.map((tool, i) => JSON.stringify({ ts: i, server: "srv", tool, ok: true })).join("\n"),
	);
	return { trajectory, toolLog };
}

describe("reconcile", () => {
	it("passes when both sides match in order", async () => {
		const { trajectory, toolLog } = await fixture(["search", "detail"], ["search", "detail"]);
		const report = await reconcile(trajectory, toolLog);
		expect(report.ok).toBe(true);
		expect(report.missingInMcp).toEqual([]);
		expect(report.missingInPi).toEqual([]);
		expect(report.orderMismatch).toBe(false);
	});

	it("reports a call recorded by pi but missing from the MCP log", async () => {
		const { trajectory, toolLog } = await fixture(["search", "detail"], ["search"]);
		const report = await reconcile(trajectory, toolLog);
		expect(report.ok).toBe(false);
		expect(report.missingInMcp).toEqual(["detail"]);
	});

	it("reports a call the MCP log has but pi did not record", async () => {
		const { trajectory, toolLog } = await fixture(["search"], ["search", "detail"]);
		const report = await reconcile(trajectory, toolLog);
		expect(report.ok).toBe(false);
		expect(report.missingInPi).toEqual(["detail"]);
	});

	it("flags an order mismatch even when the multisets match", async () => {
		const { trajectory, toolLog } = await fixture(["search", "detail"], ["detail", "search"]);
		const report = await reconcile(trajectory, toolLog);
		expect(report.ok).toBe(false);
		expect(report.orderMismatch).toBe(true);
		expect(report.missingInMcp).toEqual([]);
		expect(report.missingInPi).toEqual([]);
	});

	it("strips the server prefix pi adds on name collisions", async () => {
		const { trajectory, toolLog } = await fixture(["policy__search"], ["search"]);
		const report = await reconcile(trajectory, toolLog, ["policy"]);
		expect(report.ok).toBe(true);
	});

	it("does not strip prefix if tool name truly contains __ and server id is not recognized", async () => {
		const { trajectory, toolLog } = await fixture(["a__b"], ["a__b"]);
		const report = await reconcile(trajectory, toolLog);
		expect(report.ok).toBe(true);
		expect(report.missingInMcp).toEqual([]);
		expect(report.missingInPi).toEqual([]);
	});

	it("preserves tool name with __ when server id is not in known list", async () => {
		const { trajectory, toolLog } = await fixture(["policy__search"], ["policy__search"]);
		const report = await reconcile(trajectory, toolLog, ["other"]);
		expect(report.ok).toBe(true);
		expect(report.missingInMcp).toEqual([]);
		expect(report.missingInPi).toEqual([]);
	});

	it("reports a clean run as neither schemaMismatch nor vacuous", async () => {
		const { trajectory, toolLog } = await fixture(["search"], ["search"]);
		const report = await reconcile(trajectory, toolLog);
		expect(report.ok).toBe(true);
		expect(report.schemaMismatch).toBe(false);
		expect(report.vacuous).toBe(false);
	});

	it("flags schemaMismatch when tool_execution_end no longer carries toolName", async () => {
		// 模拟上游把 toolName 改名:事件类型还在,字段没了。
		root = await mkdtemp(join(tmpdir(), "recon-"));
		const trajectory = join(root, "trajectory.jsonl");
		const toolLog = join(root, "tool_calls.jsonl");
		await writeFile(
			trajectory,
			JSON.stringify({
				runId: "r1",
				specId: "s1",
				seq: 0,
				ts: 0,
				type: "tool_execution_end",
				payload: { name: "search" }, // 改名后的字段
			}),
		);
		await writeFile(toolLog, JSON.stringify({ ts: 0, server: "srv", tool: "search", ok: true }));

		const report = await reconcile(trajectory, toolLog);
		expect(report.schemaMismatch).toBe(true);
		expect(report.ok).toBe(false);
	});

	it("flags vacuous instead of ok when neither side recorded any tool call", async () => {
		const { trajectory, toolLog } = await fixture([], []);
		const report = await reconcile(trajectory, toolLog);
		// 两侧都空 —— 可能任务没用工具,也可能事件类型改名 + EVAL_TASK_LOG 没接通。
		// 无论哪种,都不能声称「一致」。
		expect(report.vacuous).toBe(true);
		expect(report.ok).toBe(false);
	});
});
