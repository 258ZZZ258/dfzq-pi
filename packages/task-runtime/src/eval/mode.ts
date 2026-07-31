/**
 * `--discover` / `--probes` / 正常批跑三选一。
 *
 * 之前的实现是「`--discover` 命中就直接 return」——若调用方同时传了 `--discover` 和
 * `--probes`,后者会被静默丢弃,exit code 却仍是 0。调用方只查 exit code 会误以为
 * 判据③已经跑过、四类限额都触发过 —— 这与 `judge()`/`judgeProbes()` 对「空 outcomes
 * 真空通过」的防线是同一类陷阱(静默产出一份假通过凭证),必须响亮失败,不能只加警告。
 *
 * 拆成纯函数是为了不起子进程就能单测:三个合法分支各一条断言,冲突分支断言 throw,
 * 比 spawn CLI 再解析 exit code 便宜得多。
 *
 * 范围只覆盖 `--discover` × `--probes` 这一对。`--all`/`--cases` 的静默优先级是 Task 3
 * 已记档的 deferred minor,本函数不处理。
 */
export type EvalMode = "discover" | "probes" | "batch";

export function resolveMode(flags: { discover?: boolean; probes?: boolean }): EvalMode {
	if (flags.discover && flags.probes) {
		throw new Error(
			"--discover 与 --probes 互斥:同时指定时无法判断意图 —— 只探测工具还是真的触发限额判据,请只保留一个",
		);
	}
	if (flags.discover) return "discover";
	if (flags.probes) return "probes";
	return "batch";
}
