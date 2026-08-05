import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createAuditReportRequestContext, withAuditReportRequestContext } from "./report-context.ts";
import type { AuditReportDataset } from "./report-contracts.ts";
import { createAuditReportExtension } from "./report-extension.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const auditReportSkillRoot = join(packageRoot, "skills", "audit-report");

export interface CreateAuditReportSessionOptions
	extends Omit<CreateAgentSessionOptions, "resourceLoader" | "noTools"> {}

export async function createAuditReportSession(options: CreateAuditReportSessionOptions = {}): Promise<AgentSession> {
	const cwd = options.cwd ?? process.cwd();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: options.agentDir ?? getAgentDir(),
		noExtensions: true,
		noSkills: true,
		additionalSkillPaths: [auditReportSkillRoot],
		extensionFactories: [
			{
				name: "audit-report-agent",
				factory: createAuditReportExtension(auditReportSkillRoot),
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		...options,
		cwd,
		resourceLoader: loader,
		noTools: "builtin",
		sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
	});
	return session;
}

export async function promptAuditReport(
	session: AgentSession,
	dataset: AuditReportDataset,
	instruction = "生成审计报告草稿",
): Promise<void> {
	const context = createAuditReportRequestContext(dataset);
	await withAuditReportRequestContext(context, () => session.prompt(`/skill:audit-report ${instruction}`));
}
