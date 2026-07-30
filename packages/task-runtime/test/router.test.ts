import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSpecRouter, SpecRouter } from "../src/router/router.ts";
import { clampWaitMs, validateSubmitBody, WAIT_MS_MAX } from "../src/server/middleware/validate.ts";
import type { RuntimeSpec } from "../src/spec/types.ts";

let root: string | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

function spec(id: string): RuntimeSpec {
	return { id, model: { role: "main" }, toolset: "t", tools: ["a"], limits: { maxTurns: 3 } };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		taskKind: "policy-query",
		input: "问题",
		clientRequestId: "cli-1",
		filters: { corpusTypes: ["internal"] },
		...overrides,
	};
}

describe("spec router", () => {
	it("resolves taskKind to the spec with the same id", () => {
		const router = new SpecRouter([spec("policy-query"), spec("blackbox-eval")]);
		expect(router.resolve("policy-query")?.id).toBe("policy-query");
		expect(router.taskKinds()).toEqual(new Set(["policy-query", "blackbox-eval"]));
	});

	it("returns undefined for an unknown taskKind", () => {
		expect(new SpecRouter([spec("a")]).resolve("b")).toBeUndefined();
	});

	it("throws on duplicate spec ids at construction time", () => {
		expect(() => new SpecRouter([spec("dup"), spec("dup")])).toThrow(/dup/);
	});

	it("loads specs from a directory", async () => {
		root = await mkdtemp(join(tmpdir(), "dfzq-specs-"));
		const dir = join(root, "specs");
		await mkdir(dir);
		await writeFile(join(dir, "one.json"), JSON.stringify(spec("one")));
		await writeFile(join(dir, "two.json"), JSON.stringify(spec("two")));
		await writeFile(join(dir, "notes.txt"), "ignored");

		const router = await loadSpecRouter(dir);
		expect(router.taskKinds()).toEqual(new Set(["one", "two"]));
	});

	it("throws when the directory has no .json files — misconfigured specs path must fail at assembly time, not at request time", async () => {
		root = await mkdtemp(join(tmpdir(), "dfzq-specs-"));
		const dir = join(root, "specs");
		await mkdir(dir);
		await writeFile(join(dir, "notes.txt"), "ignored");

		await expect(loadSpecRouter(dir)).rejects.toThrow(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	it("throws with the offending filename when a spec file is invalid JSON", async () => {
		root = await mkdtemp(join(tmpdir(), "dfzq-specs-"));
		const dir = join(root, "specs");
		await mkdir(dir);
		await writeFile(join(dir, "broken.json"), "{ not json");

		await expect(loadSpecRouter(dir)).rejects.toThrow(/broken\.json/);
	});
});

describe("submit body validation", () => {
	it("accepts a well-formed body", () => {
		const out = validateSubmitBody(body());
		expect(out.ok).toBe(true);
	});

	it("rejects a missing filters block with missing_authorization_scope", () => {
		const raw = body();
		delete raw.filters;
		const out = validateSubmitBody(raw);
		expect(out).toMatchObject({ ok: false, error: { code: "missing_authorization_scope" } });
	});

	it("rejects an empty corpusTypes with missing_authorization_scope", () => {
		const out = validateSubmitBody(body({ filters: { corpusTypes: [] } }));
		expect(out).toMatchObject({ ok: false, error: { code: "missing_authorization_scope" } });
	});

	it("rejects a corpusTypes with a non-string element as missing_authorization_scope, not invalid_body — a malformed element shape is disguised authorization probing", () => {
		const out = validateSubmitBody(body({ filters: { corpusTypes: [123] } }));
		expect(out).toMatchObject({ ok: false, error: { code: "missing_authorization_scope" } });
	});

	it("rejects a mixed-type corpusTypes as missing_authorization_scope too", () => {
		const out = validateSubmitBody(body({ filters: { corpusTypes: ["internal", 42] } }));
		expect(out).toMatchObject({ ok: false, error: { code: "missing_authorization_scope" } });
	});

	it("rejects a missing clientRequestId", () => {
		const raw = body();
		delete raw.clientRequestId;
		expect(validateSubmitBody(raw)).toMatchObject({ ok: false, error: { code: "invalid_body" } });
	});

	it("rejects a non-object payload", () => {
		expect(validateSubmitBody("nope")).toMatchObject({ ok: false, error: { code: "invalid_body" } });
	});
});

describe("waitMs clamping", () => {
	it("defaults when absent", () => {
		expect(clampWaitMs(undefined)).toBe(WAIT_MS_MAX);
	});

	it("clamps above the ceiling instead of erroring", () => {
		expect(clampWaitMs(600_000)).toBe(WAIT_MS_MAX);
	});

	it("keeps a smaller value", () => {
		expect(clampWaitMs(5_000)).toBe(5_000);
	});

	it("floors negative and zero to zero", () => {
		expect(clampWaitMs(-1)).toBe(0);
		expect(clampWaitMs(0)).toBe(0);
	});
});
