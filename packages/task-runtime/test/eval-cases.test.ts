import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CASE_IDS, type EvalCase, loadFormalCases, selectCases } from "../src/eval/cases.ts";

let root: string | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

function evalCase(id: string, family: string): Record<string, unknown> {
	return {
		id,
		level: "L2",
		category: "policy_data_comparison",
		case_family: family,
		prompt_variants: { precise: `问题-${id}` },
		scoring: {},
	};
}

async function fixtureRoot(cases: Array<Record<string, unknown>>): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "dfzq-eval-"));
	const dir = join(root, "data", "formal_case_rubric");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "evals.json"), JSON.stringify(cases));
	return root;
}

describe("default case set", () => {
	it("is the five-family subset fixed by the spec", () => {
		expect([...DEFAULT_CASE_IDS]).toEqual(["L1-001", "L2-003", "L3-001", "TRAP-002", "L3-007"]);
	});
});

describe("loadFormalCases", () => {
	it("reads formal_case_rubric/evals.json and maps snake_case to camelCase", async () => {
		const dir = await fixtureRoot([evalCase("L1-001", "policy_and_version")]);
		const cases = await loadFormalCases(dir);
		expect(cases).toHaveLength(1);
		expect(cases[0]).toMatchObject({
			id: "L1-001",
			caseFamily: "policy_and_version",
			promptVariants: { precise: "问题-L1-001" },
		});
	});
});

describe("selectCases", () => {
	const all: EvalCase[] = ["L1-001", "L2-003", "L3-001"].map((id) => ({
		id,
		level: "L2",
		category: "c",
		caseFamily: "f",
		promptVariants: { precise: "p" },
	}));

	it("keeps the requested ids in the requested order", () => {
		expect(selectCases(all, ["L3-001", "L1-001"]).map((c) => c.id)).toEqual(["L3-001", "L1-001"]);
	});

	it("throws naming the ids it could not find", () => {
		expect(() => selectCases(all, ["L1-001", "NOPE-9"])).toThrow(/NOPE-9/);
	});
});
