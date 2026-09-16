import { afterEach, expect, it, vi } from "vitest";
import { createAuditReportToolset } from "../src/toolsets/audit-report.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([true, false])("propagates source-loading cancellation (already aborted=%s)", async (alreadyAborted) => {
	const controller = new AbortController();
	const reason = new Error("cancel source loading");
	let received: AbortSignal | undefined;
	const fetch = vi.fn((_url: string, options: RequestInit) => {
		received = options.signal ?? undefined;
		return new Promise<Response>((_resolve, reject) => {
			received?.addEventListener("abort", () => reject(received?.reason), { once: true });
		});
	});
	vi.stubGlobal("fetch", fetch);
	if (alreadyAborted) controller.abort(reason);
	const provider = createAuditReportToolset({
		taskId: "task",
		reportType: "regular",
		apiBaseUrl: "http://unused.invalid",
		operatingWorkbookPath: "unused.xlsx",
		skillRoot: "unused",
	});
	const pending = provider(controller.signal);
	const rejected = expect(pending).rejects.toThrow("cancel source loading");
	if (!alreadyAborted) {
		expect(received).toBe(controller.signal);
		controller.abort(reason);
	}
	await rejected;
	if (alreadyAborted) expect(fetch).not.toHaveBeenCalled();
});
