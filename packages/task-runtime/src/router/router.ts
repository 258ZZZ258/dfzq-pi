import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeSpec } from "../spec/types.ts";

/**
 * taskKind → RuntimeSpec,1:1,taskKind 即 spec id。
 * 重复 id 在构造期抛,不拖到运行期(设计文档 §4.2「装配期失败要早」的同一纪律)。
 */
export class SpecRouter {
	private readonly byTaskKind = new Map<string, RuntimeSpec>();

	constructor(specs: RuntimeSpec[]) {
		for (const spec of specs) {
			if (this.byTaskKind.has(spec.id)) {
				throw new Error(`Duplicate spec id "${spec.id}" — taskKind must map to exactly one spec`);
			}
			this.byTaskKind.set(spec.id, spec);
		}
	}

	resolve(taskKind: string): RuntimeSpec | undefined {
		return this.byTaskKind.get(taskKind);
	}

	taskKinds(): Set<string> {
		return new Set(this.byTaskKind.keys());
	}
}

export async function loadSpecRouter(dir: string): Promise<SpecRouter> {
	const entries = await readdir(dir);
	const specs: RuntimeSpec[] = [];
	for (const name of entries.filter((n) => n.endsWith(".json")).sort()) {
		specs.push(JSON.parse(await readFile(join(dir, name), "utf8")) as RuntimeSpec);
	}
	return new SpecRouter(specs);
}
