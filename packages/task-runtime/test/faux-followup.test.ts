import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createFauxHarness, fauxAssistantMessage } from "./helpers/faux.ts";

let harness: Awaited<ReturnType<typeof createFauxHarness>> | undefined;
let cleanups: Array<() => void> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) fn();
	cleanups = [];
	await harness?.cleanup();
	harness = undefined;
});

describe("faux: followUp() inside turn_end", () => {
	it("records whether the agent loop continues after a turn_end followUp", { timeout: 30_000 }, async () => {
		harness = await createFauxHarness();
		harness.faux.setResponses([fauxAssistantMessage("第一轮回答"), fauxAssistantMessage("第二轮回答")]);

		// brief 里的示例在 extension 工厂内直接引用 `session`,但 `session` 要等
		// `createAgentSession()` 返回才存在 -- 那是 TDZ,编译不过。改用一个可变
		// holder:extension 在 resourceLoader.reload() 时就被实例化并订阅 turn_end,
		// 但真正调用 followUp() 发生在第一轮结束时,此时 createAgentSession 早已
		// 把 session 塞进 holder。
		const sessionHolder: { current?: AgentSession } = {};
		let injected = false;
		const extension = {
			name: "probe",
			factory: (pi: ExtensionAPI) => {
				pi.on("turn_end", async () => {
					if (injected) return;
					injected = true;
					await sessionHolder.current?.followUp("继续");
				});
			},
		};

		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [extension],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: harness.cwd,
			agentDir: harness.agentDir,
			model: harness.model,
			modelRuntime: harness.modelRuntime,
			thinkingLevel: "off",
			noTools: "all",
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(harness.cwd),
		});
		sessionHolder.current = session;
		cleanups.push(() => session.dispose());

		await session.prompt("开始");
		await session.waitForIdle();

		const assistantTurns = session.messages.filter((m) => m.role === "assistant").length;
		// 这条断言是**结论的钉子**,不是需求:实测 assistantTurns === 2。
		// assistantTurns === 2 ⇒ turn_end 里的 followUp 能让循环继续(in-loop 可行)
		// assistantTurns === 1 ⇒ 不能,run 层重判是唯一可行路径(D19 已按此实现)
		// 结论:turn_end 里的 followUp() **能**让 agent 循环继续跑下一轮 -- in-loop 可行。
		// 但 D19 已裁定重判机制做在 SessionRuntime.run() 层,本结论不改变该决策,只是
		// 把上游行为钉住:上游若改变此行为(比如 followUp 在 turn_end 里被忽略),这条
		// 测试必须变红。
		expect(injected).toBe(true);
		expect(assistantTurns).toBe(2);
	});
});
