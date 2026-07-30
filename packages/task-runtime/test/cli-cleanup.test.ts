import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAfterRun } from "../src/cli/cleanup.ts";

// Regression lock (final fix round, finding 5): main.ts's `finally` used to `await detach()`
// and `await runtime.dispose()` bare. A valid RunResult was already on stdout by then, so a
// throw from either turned a successful run into exit 1 via the top-level `.catch` --
// indistinguishable from an assembly failure, i.e. a false negative injected straight into
// blackbox-eval's verdict.

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
	stderrSpy?.mockRestore();
	stderrSpy = undefined;
});

function captureStderr(): string[] {
	const written: string[] = [];
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		written.push(String(chunk));
		return true;
	}) as never;
	return written;
}

describe("cleanupAfterRun", () => {
	it("swallows a detach failure and logs it instead of rethrowing", async () => {
		const written = captureStderr();
		const dispose = vi.fn(async () => {});

		await expect(
			cleanupAfterRun(
				async () => {
					throw new Error("detach boom");
				},
				{ dispose },
			),
		).resolves.toBeUndefined();

		expect(written.join("")).toContain("detach boom");
		expect(written.join("")).toContain("trajectory detach");
	});

	it("swallows a dispose failure and logs it instead of rethrowing", async () => {
		const written = captureStderr();

		await expect(
			cleanupAfterRun(undefined, {
				dispose: async () => {
					throw new Error("dispose boom");
				},
			}),
		).resolves.toBeUndefined();

		expect(written.join("")).toContain("dispose boom");
		expect(written.join("")).toContain("runtime dispose");
	});

	// A detach() throw must not skip dispose(): dispose() is what releases the MCP child
	// process, and this branch would otherwise quietly break the branch-wide "no orphan
	// processes" invariant.
	it("still disposes the runtime after detach throws", async () => {
		captureStderr();
		const dispose = vi.fn(async () => {});

		await cleanupAfterRun(
			async () => {
				throw new Error("detach boom");
			},
			{ dispose },
		);

		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("runs both steps in order and stays quiet on the happy path", async () => {
		const written = captureStderr();
		const order: string[] = [];

		await cleanupAfterRun(
			async () => {
				order.push("detach");
			},
			{
				dispose: async () => {
					order.push("dispose");
				},
			},
		);

		expect(order).toEqual(["detach", "dispose"]);
		expect(written).toEqual([]);
	});
});
