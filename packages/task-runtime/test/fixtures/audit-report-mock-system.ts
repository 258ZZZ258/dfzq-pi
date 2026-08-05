import { createServer, type Server } from "node:http";

export type SourceCell = string | number | boolean | null;
export type SourceRow = Record<string, SourceCell>;
export type SourceTables = Record<string, SourceRow[]>;

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function matches(row: SourceRow, field: string, expected: string | null): boolean {
	return expected === null || String(row[field] ?? "") === expected;
}

export async function startAuditReportMockSystem(tables: SourceTables): Promise<{
	baseUrl: string;
	requests: string[];
	close: () => Promise<void>;
}> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		requests.push(`${url.pathname}${url.search}`);
		const send = (data: SourceRow | SourceRow[] | null, sheet: string, status = 200) => {
			response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
			response.end(
				JSON.stringify({
					data,
					meta: {
						sourceSystem: "test-system",
						sheet,
						dataVersion: "test-v1",
						queriedAt: "2026-01-01T00:00:00.000Z",
					},
				}),
			);
		};
		const list = (sheet: string, predicate: (row: SourceRow) => boolean = () => true) =>
			send((tables[sheet] ?? []).filter(predicate), sheet);

		const project = url.pathname.match(/^\/api\/audit\/projects\/([^/]+)$/u);
		if (project)
			return send(
				(tables.审计项目 ?? []).find((row) => matches(row, "taskId", project[1] ?? "")) ?? null,
				"审计项目",
			);
		if (url.pathname === "/api/audit/projects/previous") return send(null, "审计项目");
		const organization = url.pathname.match(/^\/api\/organizations\/([^/]+)$/u);
		if (organization)
			return send(
				(tables.营业部基础库 ?? []).find((row) => matches(row, "organizationId", organization[1] ?? "")) ?? null,
				"营业部基础库",
			);
		const personnel = url.pathname.match(/^\/api\/hr\/organizations\/([^/]+)\/snapshot$/u);
		if (personnel)
			return send(
				(tables.人员快照 ?? []).find((row) => matches(row, "organizationId", personnel[1] ?? "")) ?? null,
				"人员快照",
			);
		if (url.pathname === "/api/oa/appointments") return list("OA任免发文");
		if (url.pathname === "/api/audit/findings")
			return list(
				"审计发现",
				(row) =>
					matches(row, "projectId", url.searchParams.get("projectId")) &&
					matches(row, "category", url.searchParams.get("category")),
			);
		const finding = url.pathname.match(/^\/api\/audit\/findings\/([^/]+)$/u);
		if (finding)
			return send(
				(tables.审计发现 ?? []).find((row) => matches(row, "findingId", finding[1] ?? "")) ?? null,
				"审计发现",
			);
		if (url.pathname === "/api/audit/rectifications")
			return list("整改记录", (row) => matches(row, "projectId", url.searchParams.get("projectId")));
		if (url.pathname === "/api/compliance/risk-events") return list("风险事项");
		if (url.pathname === "/api/aml/domains") return list("反洗钱领域事实");
		if (url.pathname === "/api/aml/risk-classification/new-account") return list("反洗钱新开户风险等级");
		if (url.pathname === "/api/aml/risk-classification/periodic-review") return list("反洗钱定期审核");
		if (url.pathname === "/api/aml/regulatory-letters") return list("反洗钱协查函");
		if (url.pathname === "/api/aml/suspicious-transactions") return list("总部可疑交易认定");
		if (url.pathname === "/api/audit/major-matters") return list("重大事项判断");
		if (url.pathname === "/api/aml/summary") return send(tables.反洗钱汇总?.[0] ?? null, "反洗钱汇总");
		if (url.pathname === "/api/performance") return list("绩效考核");
		if (url.pathname === "/api/audit/narrative-facts") return send(tables.审计叙述事实?.[0] ?? null, "审计叙述事实");
		if (url.pathname === "/api/source-catalog") return list("数据源目录");
		return send(null, "", 404);
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("mock system did not bind"));
			else resolve(address.port);
		});
	});
	return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => closeServer(server) };
}
