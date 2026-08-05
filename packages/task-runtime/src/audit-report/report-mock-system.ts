import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as XLSX from "@e965/xlsx";

type CellValue = string | number | boolean | null;
type FlatRecord = Record<string, CellValue>;

export interface MockSystemRequestTrace {
	method: string;
	path: string;
	status: number;
	recordCount: number;
	at: string;
}

export interface MockAuditSystem {
	baseUrl: string;
	requestTrace: MockSystemRequestTrace[];
	close(): Promise<void>;
}

function readSheet(workbook: XLSX.WorkBook, sheetName: string): FlatRecord[] {
	const sheet = workbook.Sheets[sheetName];
	if (!sheet) throw new Error(`Mock system workbook is missing sheet "${sheetName}"`);
	return XLSX.utils.sheet_to_json<FlatRecord>(sheet, { defval: null, raw: true });
}

function matches(record: FlatRecord, key: string, expected: string | null): boolean {
	return expected === null || String(record[key] ?? "") === expected;
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Mock audit system did not expose a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export async function startMockAuditSystem(workbookPath: string): Promise<MockAuditSystem> {
	const workbook = XLSX.read(await readFile(workbookPath), { type: "buffer", cellDates: true });
	const workbookStat = await stat(workbookPath);
	const dataVersion = `xlsx-${Math.trunc(workbookStat.mtimeMs)}`;
	const tables = new Map<string, FlatRecord[]>();
	for (const sheetName of workbook.SheetNames) tables.set(sheetName, readSheet(workbook, sheetName));
	const requestTrace: MockSystemRequestTrace[] = [];

	const server = createServer((request, response) => {
		const at = new Date().toISOString();
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const send = (status: number, data: FlatRecord | FlatRecord[] | null, sheet: string) => {
			const recordCount = Array.isArray(data) ? data.length : data ? 1 : 0;
			requestTrace.push({
				method: request.method ?? "GET",
				path: `${url.pathname}${url.search}`,
				status,
				recordCount,
				at,
			});
			response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
			response.end(
				JSON.stringify({
					data,
					meta: {
						sourceSystem: "mock-audit-systems",
						sheet,
						dataVersion,
						queriedAt: at,
					},
				}),
			);
		};

		if (request.method !== "GET") {
			send(405, null, "");
			return;
		}

		if (url.pathname === "/api/audit/projects/previous") {
			const organizationId = url.searchParams.get("organizationId");
			const before = url.searchParams.get("before");
			const record =
				(tables.get("审计项目") ?? [])
					.filter(
						(item) =>
							matches(item, "organizationId", organizationId) &&
							(before === null || String(item.auditEnd ?? "") < before),
					)
					.sort((left, right) => String(right.auditEnd ?? "").localeCompare(String(left.auditEnd ?? "")))[0] ??
				null;
			send(200, record, "审计项目");
			return;
		}

		const taskMatch = url.pathname.match(/^\/api\/audit\/projects\/([^/]+)$/);
		if (taskMatch) {
			const taskId = decodeURIComponent(taskMatch[1] ?? "");
			const record = tables.get("审计项目")?.find((item) => matches(item, "taskId", taskId)) ?? null;
			send(record ? 200 : 404, record, "审计项目");
			return;
		}

		const organizationMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)$/);
		if (organizationMatch) {
			const organizationId = decodeURIComponent(organizationMatch[1] ?? "");
			const record =
				tables.get("营业部基础库")?.find((item) => matches(item, "organizationId", organizationId)) ?? null;
			send(record ? 200 : 404, record, "营业部基础库");
			return;
		}

		const personnelMatch = url.pathname.match(/^\/api\/hr\/organizations\/([^/]+)\/snapshot$/);
		if (personnelMatch) {
			const organizationId = decodeURIComponent(personnelMatch[1] ?? "");
			const record = tables.get("人员快照")?.find((item) => matches(item, "organizationId", organizationId)) ?? null;
			send(record ? 200 : 404, record, "人员快照");
			return;
		}

		if (url.pathname === "/api/oa/appointments") {
			const personId = url.searchParams.get("personId");
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("OA任免发文") ?? []).filter(
				(item) =>
					matches(item, "personId", personId) &&
					(organizationId === null ||
						item.organizationId === null ||
						item.organizationId === undefined ||
						matches(item, "organizationId", organizationId)),
			);
			send(200, records, "OA任免发文");
			return;
		}

		if (url.pathname === "/api/audit/findings") {
			const organizationId = url.searchParams.get("organizationId");
			const projectId = url.searchParams.get("projectId");
			const category = url.searchParams.get("category");
			const records = (tables.get("审计发现") ?? []).filter(
				(item) =>
					matches(item, "organizationId", organizationId) &&
					matches(item, "projectId", projectId) &&
					matches(item, "category", category),
			);
			send(200, records, "审计发现");
			return;
		}

		const findingMatch = url.pathname.match(/^\/api\/audit\/findings\/([^/]+)$/);
		if (findingMatch) {
			const findingId = decodeURIComponent(findingMatch[1] ?? "");
			const record = tables.get("审计发现")?.find((item) => matches(item, "findingId", findingId)) ?? null;
			send(record ? 200 : 404, record, "审计发现");
			return;
		}

		if (url.pathname === "/api/audit/rectifications") {
			const organizationId = url.searchParams.get("organizationId");
			const projectId = url.searchParams.get("projectId");
			const records = (tables.get("整改记录") ?? []).filter(
				(item) => matches(item, "organizationId", organizationId) && matches(item, "projectId", projectId),
			);
			send(200, records, "整改记录");
			return;
		}

		if (url.pathname === "/api/compliance/risk-events") {
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("风险事项") ?? []).filter((item) =>
				matches(item, "organizationId", organizationId),
			);
			send(200, records, "风险事项");
			return;
		}

		if (url.pathname === "/api/aml/domains") {
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("反洗钱领域事实") ?? []).filter((item) =>
				matches(item, "organizationId", organizationId),
			);
			send(200, records, "反洗钱领域事实");
			return;
		}

		if (url.pathname === "/api/aml/risk-classification/new-account") {
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("反洗钱新开户风险等级") ?? []).filter((item) =>
				matches(item, "organizationId", organizationId),
			);
			send(200, records, "反洗钱新开户风险等级");
			return;
		}

		if (url.pathname === "/api/aml/risk-classification/periodic-review") {
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("反洗钱定期审核") ?? []).filter((item) =>
				matches(item, "organizationId", organizationId),
			);
			send(200, records, "反洗钱定期审核");
			return;
		}

		if (url.pathname === "/api/aml/regulatory-letters") {
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("反洗钱协查函") ?? []).filter((item) =>
				matches(item, "organizationId", organizationId),
			);
			send(200, records, "反洗钱协查函");
			return;
		}

		if (url.pathname === "/api/aml/suspicious-transactions") {
			const organizationId = url.searchParams.get("organizationId");
			const records = (tables.get("总部可疑交易认定") ?? []).filter((item) =>
				matches(item, "organizationId", organizationId),
			);
			send(200, records, "总部可疑交易认定");
			return;
		}

		if (url.pathname === "/api/aml/summary") {
			const organizationId = url.searchParams.get("organizationId");
			const record =
				tables.get("反洗钱汇总")?.find((item) => matches(item, "organizationId", organizationId)) ?? null;
			send(record ? 200 : 404, record, "反洗钱汇总");
			return;
		}

		if (url.pathname === "/api/audit/major-matters") {
			const organizationId = url.searchParams.get("organizationId");
			const projectId = url.searchParams.get("projectId");
			const records = (tables.get("重大事项判断") ?? []).filter(
				(item) => matches(item, "organizationId", organizationId) && matches(item, "projectId", projectId),
			);
			send(200, records, "重大事项判断");
			return;
		}

		if (url.pathname === "/api/performance") {
			const personId = url.searchParams.get("personId");
			const records = (tables.get("绩效考核") ?? []).filter((item) => matches(item, "personId", personId));
			send(200, records, "绩效考核");
			return;
		}

		if (url.pathname === "/api/manual-decisions") {
			const taskId = url.searchParams.get("taskId");
			const records = (tables.get("人工确认") ?? []).filter((item) => matches(item, "taskId", taskId));
			send(200, records, "人工确认");
			return;
		}

		if (url.pathname === "/api/audit/narrative-facts") {
			const organizationId = url.searchParams.get("organizationId");
			const record =
				tables.get("审计叙述事实")?.find((item) => matches(item, "organizationId", organizationId)) ?? null;
			send(record ? 200 : 404, record, "审计叙述事实");
			return;
		}

		if (url.pathname === "/api/source-catalog") {
			send(200, tables.get("数据源目录") ?? [], "数据源目录");
			return;
		}

		send(404, null, "");
	});

	const port = await listen(server);
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requestTrace,
		close: () => closeServer(server),
	};
}
