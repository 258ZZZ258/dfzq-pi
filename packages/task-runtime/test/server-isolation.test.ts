import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function tsFilesUnder(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await tsFilesUnder(full)));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * 隔离带纪律:S1a 不消费 RuntimeEvent.payload,也不该认识任何 pi 类型。
 * 钉死这一条,风险 10(隔离带被语义绕过)就确定不波及 server / store。
 */
describe("server and store stay behind the isolation boundary", () => {
	it("never import pi packages", async () => {
		const files = [...(await tsFilesUnder(join(SRC, "server"))), ...(await tsFilesUnder(join(SRC, "store")))];
		expect(files.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			if (source.includes("@earendil-works/")) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
