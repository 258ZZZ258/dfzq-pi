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
	const jsonNames = entries.filter((n) => n.endsWith(".json")).sort();
	// 目录里一个 .json 都没有,多半是 specs 路径配错。
	// 不报错就会「成功」冷启动出一个零路由的服务,所有请求要拖到运行期才报
	// unknown_task_kind —— 该在装配期就炸,与「重复 id 装配期抛错」是同一条纪律。
	if (jsonNames.length === 0) {
		throw new Error(`No spec files (*.json) found in "${dir}" — spec directory is misconfigured or empty`);
	}
	const specs: RuntimeSpec[] = [];
	for (const name of jsonNames) {
		const path = join(dir, name);
		const raw = await readFile(path, "utf8");
		try {
			specs.push(JSON.parse(raw) as RuntimeSpec);
		} catch (cause) {
			// 原生 JSON.parse 的 SyntaxError 不带文件名,排障定位慢;包一层带上文件名,
			// 保留原始错误信息。
			const reason = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Failed to parse spec file "${path}": ${reason}`);
		}
	}
	return new SpecRouter(specs);
}
