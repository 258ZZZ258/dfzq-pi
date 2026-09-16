import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SupervisionAnalysisResult } from "../../src/supervision-analysis/contracts.ts";
import { buildSupervisionReportDocument, type SupervisionReportRecords } from "../../src/supervision-analysis/report-document.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
	const key = process.argv[i];
	const value = process.argv[i + 1];
	if (!key || !["--analysis", "--narrative", "--records", "--output"].includes(key) || !value || args.has(key)) {
		throw new Error(`Invalid argument: ${key}`);
	}
	args.set(key, resolve(value));
}
for (const key of ["--analysis", "--narrative", "--records", "--output"]) {
	if (!args.has(key)) throw new Error(`Missing argument: ${key}`);
}
if (new Set(args.values()).size !== 4) throw new Error("Input and output paths must be distinct");
const analysis = JSON.parse(await readFile(args.get("--analysis")!, "utf8")) as SupervisionAnalysisResult;
const narrative: unknown = JSON.parse(await readFile(args.get("--narrative")!, "utf8"));
const records = JSON.parse(await readFile(args.get("--records")!, "utf8")) as SupervisionReportRecords;
const document = await buildSupervisionReportDocument({ analysis, narrative, records });
const output = args.get("--output")!;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ output, paragraphs: document.lineage.length, sources: document.citations.length }));
