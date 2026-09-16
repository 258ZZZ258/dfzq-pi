import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashState } from "./json.ts";

export async function configurationFingerprint(profilePath: string, specsDir: string): Promise<string> {
	const files: Array<[string, string]> = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 32 || files.length > 2000) throw new Error("configuration_manifest_too_large");
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path, depth + 1);
			else if (entry.isFile())
				files.push([
					relative(specsDir, path),
					createHash("sha256")
						.update(await readFile(path))
						.digest("hex"),
				]);
		}
	};
	await walk(specsDir, 0);
	return hashState({ piVersion: "0.82.1", profile: JSON.parse(await readFile(profilePath, "utf8")), files });
}
