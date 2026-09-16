import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "@e965/xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../src/runtime/contract.ts";
import { createWorkerFactory } from "../src/worker/factory.ts";
import { type SourceRow, type SourceTables, startAuditReportMockSystem } from "./fixtures/audit-report-mock-system.ts";
import { startMockOpenAiServer } from "./fixtures/mock-openai-server.mjs";
import { javaGrantFixture } from "./helpers/java-grant.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(packageRoot, "test", "fixtures", "audit-report-source.json");

type Fixture = SourceTables & {
	经营数据: Array<Array<string | number | null>>;
	指标字典: SourceRow[];
	排名参与家数: SourceRow[];
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
	vi.unstubAllEnvs();
});

async function writeAuditReportSpecs(specsDir: string): Promise<void> {
	await mkdir(specsDir, { recursive: true });
	await writeFile(
		join(specsDir, "audit-report.json"),
		await readFile(join(packageRoot, "specs", "audit-report.json")),
	);
	await cp(join(packageRoot, "specs", "audit-report"), join(specsDir, "audit-report"), { recursive: true });
}

async function createAuditReportSources(root: string): Promise<{
	apiBaseUrl: string;
	operatingWorkbookPath: string;
	requests: string[];
}> {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(fixture.经营数据), "经营数据");
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixture.指标字典), "指标字典");
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixture.排名参与家数), "排名参与家数");
	const operatingWorkbookPath = join(root, "operating.xlsx");
	await writeFile(operatingWorkbookPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

	const tables = { ...fixture } as Record<string, SourceRow[]>;
	delete tables.经营数据;
	delete tables.指标字典;
	delete tables.排名参与家数;
	const source = await startAuditReportMockSystem(tables);
	cleanups.push(source.close);
	return { apiBaseUrl: source.baseUrl, operatingWorkbookPath, requests: source.requests };
}

async function createServerFixture(): Promise<{
	token: (overrides: Parameters<ReturnType<typeof javaGrantFixture>["token"]>[0]) => string;
	run: (token: string, clientRequestId: string) => Promise<RunResult>;
	sourceRequests: string[];
	modelRequests: unknown[];
}> {
	const root = await mkdtemp(join(tmpdir(), "audit-report-worker-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const specsDir = join(root, "specs");
	await writeAuditReportSpecs(specsDir);
	const sources = await createAuditReportSources(root);
	const model = await startMockOpenAiServer({
		toolCall: { name: "get_report_task", arguments: {} },
		finalText: "mock final text that intentionally does not satisfy the report schema",
	});
	cleanups.push(model.close);
	vi.stubEnv("AUDIT_REPORT_WORKER_KEY", "local-test-only");
	await writeFile(
		join(root, "profile.json"),
		JSON.stringify({
			id: "local",
			baseUrl: model.baseUrl,
			apiKeyEnv: "AUDIT_REPORT_WORKER_KEY",
			api: "openai-completions",
			roles: {
				main: {
					provider: "local",
					modelId: "mock-model",
					contextWindow: 128000,
					maxTokens: 8192,
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			},
		}),
	);
	const java = javaGrantFixture();
	const workerFactory = await createWorkerFactory({
		profilePath: join(root, "profile.json"),
		specsDir,
		workRoot: join(root, "runs"),
		auditReportSources: {
			apiBaseUrl: sources.apiBaseUrl,
			operatingWorkbookPath: sources.operatingWorkbookPath,
		},
	});
	return {
		token: (overrides) => java.token(overrides),
		sourceRequests: sources.requests,
		modelRequests: model.requests as unknown[],
		run: async (token, clientRequestId) => {
			const runtime = await workerFactory({
				specId: "audit-report",
				sessionId: "s1",
				runId: clientRequestId,
				filters: { corpusTypes: ["internal"], permTags: ["d1"] },
				options: {
					authorization: java.verifier.verify(token),
					reportTaskId: "TASK-001",
					reportType: "regular",
				},
			});
			try {
				return await runtime.run("读取报告任务", { runId: clientRequestId });
			} finally {
				await runtime.dispose();
			}
		},
	};
}

function requestTools(request: unknown): string[] {
	const tools = (request as { tools?: Array<{ function?: { name?: unknown } }> }).tools ?? [];
	return tools.map((tool) => tool.function?.name).filter((name): name is string => typeof name === "string");
}

function toolMessageText(request: unknown): string {
	const messages = (request as { messages?: Array<{ role?: unknown; content?: unknown }> }).messages ?? [];
	return messages
		.filter((message) => message.role === "tool" && typeof message.content === "string")
		.map((message) => message.content as string)
		.join("\n");
}

describe("audit-report worker integration", () => {
	it("loads remote audit-report sources inside an isolated worker and lets a signed grant call get_report_task", async () => {
		const fixture = await createServerFixture();
		const allowedToken = fixture.token({
			sessionId: "s1",
			taskKinds: ["audit-report"],
			tools: ["get_report_task"],
			dataScope: { corpusTypes: ["internal"], permTags: ["d1"] },
		});

		const result = await fixture.run(allowedToken, "allowed");

		expect(result.status).not.toBe("aborted");
		expect(fixture.sourceRequests).toContain("/api/audit/projects/TASK-001");
		expect(requestTools(fixture.modelRequests[0])).toEqual(["get_report_task"]);
		const taskToolResult = toolMessageText(fixture.modelRequests[1]);
		expect(taskToolResult).toContain('"taskId": "TASK-001"');
		expect(taskToolResult).toContain('"closingOrganization": "测试证券公司"');
	});

	it("removes get_report_task from the worker tool whitelist when the signed grant does not include it", async () => {
		const fixture = await createServerFixture();
		const deniedToken = fixture.token({
			sessionId: "s1",
			taskKinds: ["audit-report"],
			tools: ["generate_report_draft"],
			dataScope: { corpusTypes: ["internal"], permTags: ["d1"] },
		});

		const result = await fixture.run(deniedToken, "denied");

		expect(result.status).not.toBe("completed");
		expect(requestTools(fixture.modelRequests[0])).toEqual(["generate_report_draft"]);
		expect(JSON.stringify(fixture.modelRequests)).not.toContain('"closingOrganization": "测试证券公司"');
	});
});
