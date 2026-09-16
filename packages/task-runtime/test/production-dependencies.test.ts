import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("deployed dependency contract", () => {
	it("pins the direct Pi runtime and test provider to exact versions", async () => {
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.devDependencies["@earendil-works/pi-ai"]).toBe(pkg.dependencies["@earendil-works/pi-coding-agent"]);
	});

	it("verifies native Node resolution against the package and lock, without source aliases", async () => {
		const { stdout } = await run(process.execPath, ["scripts/check-runtime-dependencies.mjs"], {
			cwd: packageRoot,
			timeout: 10_000,
		});
		const report = JSON.parse(stdout);
		expect(report.dependencies).toHaveLength(2);
		for (const item of report.dependencies) {
			expect(item.installed).toBe(item.requested);
			expect(item.locked).toBe(item.requested);
			expect(item.entry).toContain("/dist/");
		}
		expect(report.lockSha256).toMatch(/^[a-f0-9]{64}$/);
	});
});
