import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lockText = await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8");
const lock = JSON.parse(lockText);
const dependencies = [];

for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
	const requested = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
	if (!/^\d+\.\d+\.\d+$/.test(requested ?? "")) throw new Error(`${name} must use an exact version`);
	const entry = fileURLToPath(import.meta.resolve(name));
	let dir = dirname(entry);
	let installed;
	while (dirname(dir) !== dir) {
		try {
			const candidate = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			if (candidate.name === name) {
				installed = candidate.version;
				break;
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		dir = dirname(dir);
	}
	const locked = (lock.packages[`packages/task-runtime/node_modules/${name}`] ?? lock.packages[`node_modules/${name}`])?.version;
	if (installed !== requested || locked !== requested) {
		throw new Error(`${name}: requested=${requested}, installed=${installed}, locked=${locked}, entry=${entry}`);
	}
	if (!entry.includes("/dist/")) throw new Error(`${name} resolved to source instead of its installed artifact: ${entry}`);
	dependencies.push({ name, requested, installed, locked, entry });
}

console.log(JSON.stringify({ node: process.version, lockSha256: createHash("sha256").update(lockText).digest("hex"), dependencies }, null, 2));
