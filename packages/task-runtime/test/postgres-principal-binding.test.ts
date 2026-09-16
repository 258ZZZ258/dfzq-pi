import { expect, it, vi } from "vitest";
import { createPostgresRunStore } from "../src/store/postgres.ts";

vi.mock("postgres", () => ({
	default: () =>
		Object.assign(async () => [], {
			unsafe: async (query: string, params: unknown[]) => {
				const match = /INSERT INTO task_runs\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/.exec(query);
				if (!match) throw new Error("unexpected query");
				const columns = match[1].split(",").map((s) => s.trim()),
					values = match[2].split(",").map((s) => s.trim());
				if (columns.length !== values.length) throw new Error("INSERT has more expressions than target columns");
				const row: Record<string, unknown> = {};
				for (let i = 0; i < columns.length; i++)
					row[columns[i]] = values[i].startsWith("$")
						? params[Number.parseInt(values[i].slice(1), 10) - 1]
						: "queued";
				for (const key of ["principal_json", "filters_json", "payload_json"])
					if (typeof row[key] === "string") row[key] = JSON.parse(row[key]);
				return [row];
			},
			end: async () => {},
		}),
}));
it("binds the independent principal into the PostgreSQL INSERT column and value lists", async () => {
	const store = await createPostgresRunStore("test-only");
	try {
		const principalJson = JSON.stringify({ tenantId: "t", userId: "u" });
		const result = await store.insertQueued({
			runId: "r",
			clientRequestId: "c",
			specId: "s",
			taskKind: "s",
			sessionId: "session",
			filtersJson: '{"corpusTypes":["internal"]}',
			principalJson,
			createdAt: 1,
			input: "q",
		});
		expect(result.run.principalJson).toBe(principalJson);
	} finally {
		await store.close();
	}
});

it.each(["123", '{"looks":"like JSON"}'])("preserves a legitimate JSONB string payload: %s", async (payload) => {
	const store = await createPostgresRunStore("test-only");
	try {
		const payloadJson = JSON.stringify(payload);
		const result = await store.insertQueued({
			runId: "r",
			clientRequestId: "c",
			specId: "s",
			taskKind: "s",
			sessionId: "session",
			filtersJson: '{"corpusTypes":["internal"]}',
			payloadJson,
			createdAt: 1,
			input: "q",
		});
		expect(result.run.payloadJson).toBe(payloadJson);
	} finally {
		await store.close();
	}
});
