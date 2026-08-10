import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type TextContent,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface FauxHarness {
	modelRuntime: ModelRuntime;
	model: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>;
	faux: ReturnType<typeof registerFauxProvider>;
	root: string;
	cwd: string;
	agentDir: string;
	cleanup: () => Promise<void>;
}

export async function createFauxHarness(): Promise<FauxHarness> {
	const faux = registerFauxProvider();
	const root = await mkdtemp(join(tmpdir(), "dfzq-rt-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	// ModelRuntime.create's CreateModelRuntimeOptions only special-cases `null`
	// for modelsPath (it forces an in-memory ModelsStore). `authPath` is typed
	// `string | undefined` -- there is no null variant -- so passing `null`
	// there would both fail to type-check and, if coerced away, fall back to
	// the real ~/.pi/agent/auth.json (AuthStorage creates that file on first
	// use). Point it at a path inside our own tmpdir instead so tests never
	// touch the real user auth store.
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(root, "auth.json") });
	const model = faux.getModel();
	// registerFauxProvider() only wires the faux streaming implementation into pi-ai's
	// low-level api-registry (compat.ts) -- it never touches ModelRuntime. Without also
	// registering it here, AgentSession.prompt()'s `modelRuntime.checkAuth(model.provider)`
	// finds no configured provider and throws "No API key found for faux." Mirrors the
	// pattern coding-agent's own faux test harness uses (test/suite/harness.ts).
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	return {
		modelRuntime,
		model,
		faux,
		root,
		cwd,
		agentDir,
		cleanup: async () => {
			faux.unregister();
			await rm(root, { recursive: true, force: true });
		},
	};
}

export { fauxAssistantMessage, fauxToolCall };

/** `UserMessage.content` is `string | (TextContent | ImageContent)[]` (pi-ai's `types.ts`) --
 *  faux fixtures and production code both only ever send plain text, so this only needs to
 *  handle the array shape by joining its `TextContent` blocks (image blocks, if any, contribute
 *  nothing -- no test in this package sends an image). */
function userMessageText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * I-1:faux 的默认回复(`fauxAssistantMessage(...)` 传给 `setResponses`)纯按位置吐,从不读
 * `context` —— `registerFauxProvider` 的 `stream()` 只是 `pendingResponses.shift()`。这意味着
 * "模型①实际收到的是不是改写指令""模型②实际收到的证据块里有没有 `正文:` 那一行"这类问题,
 * 光看 faux 回了什么完全判不出来。
 *
 * pi-ai 的 faux provider 允许 `FauxResponseStep` 是一个函数(`FauxResponseFactory`),
 * `stream()` 调用它时会把当次请求的完整 `Context`(含 `context.messages`)传进去
 * (`faux.ts` 的 `stream()`:`typeof step === "function" ? await step(context, ...) : step`)。
 * `AgentSession.prompt(text)` 在发起这次 provider 请求前已经把 `text` 追加成
 * `context.messages` 的最后一条 user 消息(实测见 `capturingReply` 的调用点),所以
 * "`context.messages` 最后一条 user 消息的文本"就是 `session.prompt()` 这次实际发送的文本
 * ——不是 faux 编出来的,是 pi 真的组装进 provider 请求里的那一份。
 *
 * 用它替换 `fauxAssistantMessage(reply)` 塞进 `setResponses`,`sink` 数组按调用顺序积累每次
 * 请求实际收到的文本,回复行为不变(仍然返回同一个 `text`)。
 */
export function capturingReply(text: string, sink: string[]): FauxResponseFactory {
	return (context: Context) => {
		const last = context.messages[context.messages.length - 1];
		sink.push(
			last?.role === "user" ? userMessageText(last.content) : `<no trailing user message; last role: ${last?.role}>`,
		);
		return fauxAssistantMessage(text);
	};
}
