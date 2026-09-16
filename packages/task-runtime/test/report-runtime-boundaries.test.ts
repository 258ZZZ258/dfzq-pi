import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AuditReportDataset, ReportDraft } from "../src/audit-report/report-contracts.ts";
import type { NarrativeModelCall, ReportNarrativeProcessor } from "../src/audit-report/report-narrative-processing.ts";
import type { NarrativeRewriteInput } from "../src/audit-report/report-narrative-rewrite.ts";
import { createAuditReportRuntime } from "../src/audit-report/report-runtime.ts";
import type { ProviderProfile } from "../src/env/provider-profile.ts";
import { createDefaultPluginRegistry } from "../src/runtime/default-plugins.ts";
import { sealDelivery, verifyDelivery } from "../src/runtime/delivery.ts";
import type { CreateSessionRuntimeOptions } from "../src/runtime/session-runtime.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";
import { ToolsetRegistry } from "../src/toolsets/registry.ts";
import { createStubRuntime } from "./helpers/stub-runtime.ts";

const state = vi.hoisted(() => ({
	processor: undefined as ReportNarrativeProcessor | undefined,
	calls: [] as string[],
	childSignals: [] as Array<AbortSignal | undefined>,
}));
vi.mock("../src/audit-report/report-narrative-processing.ts", () => ({
	processReportNarratives: async (
		_dataset: AuditReportDataset,
		draft: ReportDraft,
		options: { callModel: NarrativeModelCall; signal: AbortSignal },
	) => {
		for (let i = 0; i < 2; i++)
			await options.callModel({ phase: "rewrite", input: {} as NarrativeRewriteInput }, options.signal);
		return { draft, records: [] };
	},
}));
vi.mock("../src/runtime/session-runtime.ts", () => ({
	createSessionRuntime: async (options: CreateSessionRuntimeOptions) => {
		const runtime = createStubRuntime({ specId: options.spec.id, result: { output: "{}" } });
		const baseRun = runtime.run;
		if (options.spec.id !== "report") state.childSignals.push(options.signal);
		runtime.run = async (input, runOptions) => {
			const result = await baseRun(input, runOptions);
			try {
				await options.authorizeExecution?.();
				options.consumeModelTurn?.();
				state.calls.push(options.spec.id);
				if (options.spec.id === "report") {
					await state.processor?.({ task: { taskId: "task" } } as AuditReportDataset, {} as ReportDraft);
					await options.authorizeExecution?.();
					options.consumeModelTurn?.();
					state.calls.push("report-final");
				}
			} catch (error) {
				result.status = "error";
				result.errorMessage = String(error);
			}
			return sealDelivery(result, "not_checked");
		};
		return runtime;
	},
}));
afterEach(() => {
	state.calls.length = 0;
	state.childSignals.length = 0;
	state.processor = undefined;
});

it.each([
	{ maxTurns: 3, revoked: false, expected: "limit_exceeded", calls: 3 },
	{ maxTurns: 10, revoked: true, expected: "error", calls: 2 },
])(
	"shares turns and authorization across narrative phases: $expected",
	async ({ maxTurns, revoked, expected, calls }) => {
		const directory = await mkdtemp(join(tmpdir(), "report-boundary-"));
		const phase: RuntimeSpec = {
			id: "rewrite",
			model: { role: "main" },
			toolset: "empty",
			toolMode: "none",
			tools: [],
			limits: { maxTurns: 2, runTimeoutMs: 1000 },
		};
		const runtime = await createAuditReportRuntime({
			spec: {
				id: "report",
				model: { role: "main" },
				toolset: "report",
				tools: ["generate"],
				limits: { maxTurns, runTimeoutMs: 10000 },
			},
			profile: {} as ProviderProfile,
			registry: createDefaultPluginRegistry(),
			cwd: directory,
			agentDir: directory,
			narrativeSpecs: { rewrite: phase, review: { ...phase, id: "review" } },
			authorizeExecution: async () => {
				if (revoked && state.calls.length >= 2) throw new Error("authorization_revoked");
			},
			buildToolsets: (processor) => {
				state.processor = processor;
				return new ToolsetRegistry();
			},
		});
		try {
			const result = await runtime.run("run");
			expect(result.status).toBe(expected);
			expect(state.calls).toHaveLength(calls);
			expect(result.turns).toBe(calls);
			expect(verifyDelivery(result).status).toBe(expected);
			expect(state.childSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
			if (!revoked) expect(result.delivery?.error?.code).toBe("max_turns");
		} finally {
			await runtime.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
