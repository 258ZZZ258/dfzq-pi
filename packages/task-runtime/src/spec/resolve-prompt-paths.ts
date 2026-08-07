import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeSpec } from "./types.ts";

/**
 * 形似路径的启发式(审查 Important-5,裁定采纳):含 `/`,或以 `.md` / `.json` 结尾。
 *
 * 只用在 `appendSystemPrompt` 上——`systemPrompt` 无条件当路径处理,不需要这条判断
 * (见下面 `resolveSpecPromptPaths` 的文档)。
 *
 * **已知代价,裁定认为可接受**:真想传一段含斜杠的字面文本(比如 "选 A/B 方案都可以")会被
 * 误判成路径,`resolve(specsDir, item)` 大概率不存在,于是在构造期抛错而不是把这段文本原样
 * 当字面文本使用。裁定的权衡是:prompt 正文里出现这种形状的字面文本极少见,而"形似路径但拼
 * 错/文件不存在时静默退化成字面文本"的代价大得多——出厂 spec 的输出契约(`output-format.md`)
 * 正是走这个字段,拼错路径会让契约正文悄悄从模型的 context 里消失,却没有任何报错。
 */
function looksLikePath(item: string): boolean {
	return item.includes("/") || item.endsWith(".md") || item.endsWith(".json");
}

/**
 * 无条件当路径处理的单个字段:构造期 `readFile` 成正文,读不到直接抛(与 `looksLikePath()`
 * 的启发式判断无关)。`spec.systemPrompt` 与 `spec.fastPath` 的三个 prompt 字段
 * (`systemPrompt` / `rewritePrompt` / `answerPrompt`)共用这一条语义——它们在出厂 spec 里都
 * 只有「路径」这一种用法,不需要 `appendSystemPrompt` 那种「字面文本 or 路径」的二选一判断。
 *
 * 错误信息带 spec id、字段名(含 `fastPath.` 前缀区分是哪个字段)、原始值、解析后的绝对路径,
 * 与既有的 `systemPrompt` / `appendSystemPrompt` 报错同构。
 *
 * ⚠ `original` 形参标了 `string`,但生产序上 `resolveSpecPromptPaths` 跑在 `validateSpec` 之前
 * (`server/main.ts` 先解析 prompt 路径,`assemble()` 内部才校验 spec 形状)——一个畸形 spec
 * (比如 `fastPath` 缺了某个 prompt 字段)在校验层拦下之前会先走到这里,此时 `original` 在运行期
 * 可能是 `undefined`。`resolve(specsDir, undefined)` 会抛一个不带 spec id / 字段名的
 * `ERR_INVALID_ARG_TYPE`,与 `readFile` 失败时的报错形状不同构,排障时看不出是哪个 spec、哪个
 * 字段——下面这行前置校验把它拦成与 `readFile` 失败同构的报错。
 */
async function readPromptPathField(
	specId: string,
	fieldLabel: string,
	original: string,
	specsDir: string,
): Promise<string> {
	if (typeof original !== "string") {
		throw new Error(`Spec "${specId}": ${fieldLabel} must be a non-empty file path, got ${JSON.stringify(original)}`);
	}
	const abs = resolve(specsDir, original);
	try {
		return await readFile(abs, "utf8");
	} catch (error) {
		throw new Error(
			`Spec "${specId}": ${fieldLabel} "${original}" (resolved to "${abs}") could not be read — ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * `spec.systemPrompt` / `spec.fastPath`(三个 prompt 字段) / `spec.appendSystemPrompt`
 * 就地解析成实际正文——直接改写传入对象上的这些字段,不返回新对象。
 *
 * **抽成独立模块的原因(审查 Important-3)**:这段逻辑原来在 `server/main.ts` 与
 * `cli/main.ts` 里各写了一份逐字重复的实现。CLI 那份没有由 `createDefaultRuntimeFactory`
 * 覆盖到,曾经完全没有测试守着(变异检验:整段删掉 `cli/main.ts` 里的重复实现,`npm test` 一条
 * 都不红)。挪到这个无依赖的模块(只 import `node:fs/promises` / `node:path` 与
 * `./types.ts`,不碰 `@hono/node-server` / `node:sqlite`),让 `server/main.ts` 与
 * `cli/main.ts` 都从这里 import——`cli/main.ts` 顶部已有的纪律("serve" 分支才动态
 * `import("./serve.ts")`,为的是不让单跑 CLI 背上 server 的 hono/sqlite 依赖)因此不受影响,
 * 同时消除了两份实现之间的漂移风险。
 *
 * **为什么要在构造期把文件读出来,而不是把解析出的绝对路径原样交给 pi**:pi 的
 * `resolvePromptInput`(packages/coding-agent/src/core/resource-loader.ts:53-67)是
 * `existsSync(input) ? readFileSync(input) : input`——路径读不到就把路径字符串本身当 prompt
 * 正文,不抛也不告警。task-runtime 如果只算出绝对路径丢给它,路径写错(比如曾经的
 * `"@specs/policy-query/system.md"` 前缀)不会在装配阶段暴露,而是让模型静默收到一串文件路径
 * 当系统提示——这正是 `spec.systemPrompt` 自 3dc0d28c 起从未生效过的根因。
 *
 * - `systemPrompt`:出厂 spec 里就是路径(`specs/policy-query.json` 的
 *   `"policy-query/system.md"`),没有任何字面文本用例依赖它——无条件当路径处理,读不到直接
 *   抛,错误信息带 spec id 与字段名,方便定位是哪个 spec、哪个字段写错了路径。
 * - `fastPath.systemPrompt` / `fastPath.rewritePrompt` / `fastPath.answerPrompt`:与
 *   `systemPrompt` 同一条语义(无条件当路径),理由相同——这三个字段在出厂 spec 里同样只有
 *   「路径」一种用法,没有字面文本用例。**不套用 `looksLikePath()` 那套启发式**:那条启发式
 *   存在的唯一原因是 `appendSystemPrompt` 必须同时支持字面文本,而这三个字段没有这个需求;
 *   套用启发式只会多一条不需要的分支,拼错的路径反而可能被误判成字面文本静默放行。
 * - `appendSystemPrompt`:既有语义是"每一项要么是字面文本、要么是文件路径"
 *   (`runtime/assembler.ts` 里 `appendSystemPrompt` 选项那段注释),`test/assembler.test.ts`
 *   有两条用例直接把字面文本(`"DFZQ-APPENDED-ONE"` 等)传给 `assemble()`——那两条用例直接
 *   构造 `RuntimeSpec` 传给 `assemble()`,根本不经过 `createDefaultRuntimeFactory` /
 *   `cli/main.ts` / 这个函数,不受影响。
 *
 *   判据(审查 Important-5 裁定,取代了这里原先的纯 `existsSync` 分流):先用
 *   `looksLikePath()` 判断这一项"形似路径"——不形似就直接当字面文本原样传下去,不碰文件系统;
 *   形似路径就必须能读到,读不到直接抛(与 `systemPrompt` 同构的错误信息:spec id、字段名、
 *   原值、解析后的绝对路径)。
 *
 *   **这是本次改动新加的行为,不是延续旧判据**:旧判据是"`resolve(specsDir, item)` 存在就读
 *   成正文,不存在就原样当字面文本继续传下去"——这条旧判据本身就是本 task 要消灭的那种静默
 *   失效模式的一个变种:一个形似路径但拼错/文件不存在的 `appendSystemPrompt` 条目(比如
 *   `"policy-query/TYPO-output-format.md"`)会被悄悄当成字面文本喂给模型,不抛也不告警——
 *   而出厂 spec 的输出契约正文正是走这个字段(`policy-query.json` 的
 *   `"appendSystemPrompt": ["policy-query/output-format.md"]`),拼错路径会让契约悄悄从模型
 *   的 context 里消失。新判据把"形似路径但读不到"这种情况从静默降级改成响亮失败。
 */
export async function resolveSpecPromptPaths(spec: RuntimeSpec, specsDir: string): Promise<void> {
	if (spec.systemPrompt !== undefined) {
		spec.systemPrompt = await readPromptPathField(spec.id, "systemPrompt", spec.systemPrompt, specsDir);
	}
	if (spec.fastPath !== undefined) {
		const fp = spec.fastPath;
		fp.systemPrompt = await readPromptPathField(spec.id, "fastPath.systemPrompt", fp.systemPrompt, specsDir);
		fp.rewritePrompt = await readPromptPathField(spec.id, "fastPath.rewritePrompt", fp.rewritePrompt, specsDir);
		fp.answerPrompt = await readPromptPathField(spec.id, "fastPath.answerPrompt", fp.answerPrompt, specsDir);
	}
	if (spec.appendSystemPrompt?.length) {
		spec.appendSystemPrompt = await Promise.all(
			spec.appendSystemPrompt.map(async (item) => {
				if (!looksLikePath(item)) return item; // 不形似路径 = 字面文本,原样传下去
				const abs = resolve(specsDir, item);
				try {
					return await readFile(abs, "utf8");
				} catch (error) {
					throw new Error(
						`Spec "${spec.id}": appendSystemPrompt "${item}" (resolved to "${abs}") could not be read — ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}),
		);
	}
}
