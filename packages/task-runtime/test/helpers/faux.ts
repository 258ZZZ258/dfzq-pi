import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
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

export { fauxAssistantMessage };
