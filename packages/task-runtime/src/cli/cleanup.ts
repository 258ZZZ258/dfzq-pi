/**
 * CLI 收尾阶段的清理。单独成文件是为了能在不执行 main.ts 顶层 `main()` 的前提下测到它
 * —— 而不是往生产代码里塞测试开关。
 */

/** 只要求 dispose(),不依赖完整的 Runtime —— 这里不需要别的东西。 */
interface Disposable {
	dispose: () => Promise<void>;
}

/**
 * 清理阶段的失败**不得**改写已经确定的退出码。
 *
 * RunResult 在调用到这里时已经写到 stdout 了。让 detach() / dispose() 的错误冒泡到顶层
 * `.catch`,就会把一次成功的 run 变成 exit 1,与"装配失败"不可区分 —— 那等于往
 * blackbox-eval 的判定里注入假阴性(任务其实成功了却被判失败)。记日志到 stderr 即可。
 *
 * 两步各自 try/catch 而不是包在一起:detach() 抛错不能连带跳过 dispose(),否则本分支
 * 为之建立的"不留孤儿进程"不变量会被这条路径破掉(MCP 子进程泄漏)。
 */
export async function cleanupAfterRun(detach: (() => Promise<void>) | undefined, runtime: Disposable): Promise<void> {
	if (detach) {
		try {
			await detach();
		} catch (error) {
			warnCleanupFailure("trajectory detach", error);
		}
	}
	try {
		await runtime.dispose();
	} catch (error) {
		warnCleanupFailure("runtime dispose", error);
	}
}

function warnCleanupFailure(stage: string, error: unknown): void {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`[task-runtime] ${stage} failed during cleanup (exit code unchanged): ${detail}\n`);
}
