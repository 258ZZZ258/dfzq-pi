import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultRuntimeFactory, startServer } from "../src/server/main.ts";
import * as sqliteModule from "../src/store/sqlite.ts";
import { createSqliteRunStore } from "../src/store/sqlite.ts";
import { createStubRuntime, type StubRuntime } from "./helpers/stub-runtime.ts";

/** 构造期不会真的拨号验证 provider——这里只要是能被 JSON.parse 成 ProviderProfile 形状的
 *  最小合法值,与本文件既有的 Minor-c 用例(:225-244)用的是同一份数据,抽成 helper 避免
 *  在下面三条新用例里三次逐字重复。 */
function minimalProfile(): unknown {
	return {
		id: "p",
		baseUrl: "http://127.0.0.1:1",
		apiKeyEnv: "X",
		api: "openai-completions",
		roles: {
			main: {
				provider: "p",
				modelId: "m",
				contextWindow: 1000,
				maxTokens: 100,
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
	};
}

const CASE_TIMEOUT_MS = 30_000;

let root: string;
let stop: (() => Promise<void>) | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dfzq-boot-"));
	const specs = join(root, "specs");
	await mkdir(specs);
	await writeFile(
		join(specs, "demo.json"),
		JSON.stringify({ id: "demo", model: { role: "main" }, toolset: "t", tools: ["a"], limits: { maxTurns: 3 } }),
	);
});

afterEach(async () => {
	// 必须显式 close():port 0 拿的是随机端口,不关就是残留监听。
	if (stop) await stop();
	stop = undefined;
	await rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("server startup", () => {
	it(
		"marks queued and running rows as error before accepting requests",
		async () => {
			const dbPath = join(root, "runs.db");
			const seed = createSqliteRunStore(dbPath);
			seed.insertQueued({
				runId: "stale-queued",
				clientRequestId: "c1",
				specId: "demo",
				taskKind: "demo",
				sessionId: "s1",
				filtersJson: "{}",
				input: "x",
				createdAt: 1,
			});
			seed.insertQueued({
				runId: "stale-running",
				clientRequestId: "c2",
				specId: "demo",
				taskKind: "demo",
				sessionId: "s2",
				filtersJson: "{}",
				input: "x",
				createdAt: 2,
			});
			seed.markRunning("stale-running", 3);
			seed.close();

			const server = await startServer({
				port: 0,
				dbPath,
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;

			const check = createSqliteRunStore(dbPath);
			for (const id of ["stale-queued", "stale-running"]) {
				expect(check.findByRunId(id)).toMatchObject({ status: "error", errorMessage: "process restarted" });
			}
			check.close();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"serves healthz on the bound port",
		async () => {
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;
			const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
				signal: AbortSignal.timeout(5_000),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, activeRuns: 0 });
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"serves the full submit/fetch/cancel cycle over a real socket",
		async () => {
			// ★ 其余 HTTP 用例走 app.request(),绕过 @hono/node-server 适配层与真实 socket。
			// 而出口判据说的是「Java 能发任务/取结果/取消」—— 那是真实 HTTP。适配层的接线 bug
			// (body 解析、header 大小写、状态码透传)只有这条用例能抓到。
			//
			// 第一个 run 走正常完成路径(下面 submit/fetch/已终态取消-409 三步用它);第二个
			// run 特意造成 hang,专供后面「取消受理 → abort 传导 → 终态转 aborted」用 ——
			// 判据①「取消」的动词那一半此前只在 app.request() 层证明过,真实 socket 上从未验证。
			const stubs: StubRuntime[] = [];
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => {
					const stub = createStubRuntime(stubs.length === 0 ? {} : { hang: true });
					stubs.push(stub);
					return stub;
				},
			});
			stop = server.close;
			const base = `http://127.0.0.1:${server.port}`;
			const headers = { "content-type": "application/json", "X-Internal-Token": "t" };

			// 发任务(header 名故意用混合大小写:HTTP 头大小写不敏感,适配层不该漏读)
			const submit = await fetch(`${base}/runs`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					taskKind: "demo",
					input: "问题",
					clientRequestId: "real-1",
					filters: { corpusTypes: ["internal"] },
					waitMs: 5000,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			expect(submit.status).toBe(200);
			const submitted = (await submit.json()) as { runId: string; status: string };
			expect(submitted.status).toBe("completed");

			// 取结果
			const fetched = await fetch(`${base}/runs/${submitted.runId}`, {
				headers: { "X-Internal-Token": "t" },
				signal: AbortSignal.timeout(5_000),
			});
			expect(fetched.status).toBe(200);
			expect(await fetched.json()).toMatchObject({ runId: submitted.runId, status: "completed" });

			// 取消已终态的 run → 409(证明错误路径的状态码也真的透出来了)
			const cancelled = await fetch(`${base}/runs/${submitted.runId}/cancel`, {
				method: "POST",
				headers: { "X-Internal-Token": "t" },
				signal: AbortSignal.timeout(5_000),
			});
			expect(cancelled.status).toBe(409);

			// 未带 token → 401(鉴权在真实链路上生效,不是只在 app.request() 里生效)
			const unauth = await fetch(`${base}/healthz`.replace("/healthz", "/runs/nope"), {
				signal: AbortSignal.timeout(5_000),
			});
			expect(unauth.status).toBe(401);

			// 判据①「取消」的真实语义:202 受理 → abort() 传导 → 终态转 aborted。
			// 上面 409 那一步只证明了取消的错误路径,这里补上正常路径。
			const hangSubmit = await fetch(`${base}/runs`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					taskKind: "demo",
					input: "hang",
					clientRequestId: "real-hang-1",
					filters: { corpusTypes: ["internal"] },
					waitMs: 50,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			expect(hangSubmit.status).toBe(202);
			const hangSubmitted = (await hangSubmit.json()) as { runId: string; status: string };
			expect(hangSubmitted.status).toBe("running");

			const hangCancel = await fetch(`${base}/runs/${hangSubmitted.runId}/cancel`, {
				method: "POST",
				headers: { "X-Internal-Token": "t" },
				signal: AbortSignal.timeout(5_000),
			});
			expect(hangCancel.status).toBe(202);

			// 推动 stub 完成:cancel() 内部已经 await 过 abort()(即 settle()),这里再拨一次
			// 是安全的空操作,只是为了让"取消已经真正传导"这件事不依赖时序巧合。
			stubs[1]?.resolveNow();
			await new Promise((resolve) => setTimeout(resolve, 20));

			const hangFetched = await fetch(`${base}/runs/${hangSubmitted.runId}`, {
				headers: { "X-Internal-Token": "t" },
				signal: AbortSignal.timeout(5_000),
			});
			expect(hangFetched.status).toBe(200);
			expect(await hangFetched.json()).toMatchObject({ runId: hangSubmitted.runId, status: "aborted" });
		},
		CASE_TIMEOUT_MS,
	);
});

// 审查 Minor-c 的回归锁:outputContract.schema 此前放在 createDefaultRuntimeFactory 返回的
// 工厂函数体内、每次 run 才读一次 —— 坏 schema(缺失/损坏)要拖到第一次真实请求才暴露。
// 挪到构造期的 for 循环里、与 spec 一起预读之后,坏 schema 必须在 createDefaultRuntimeFactory()
// 本身就响亮失败,不必等 runtimeFactory 被调用过一次。
describe("createDefaultRuntimeFactory - outputContract schema reading (Minor-c)", () => {
	it("fails at construction time when outputContract.schema is missing, not on the first run", async () => {
		const specsDir = join(root, "specs");
		await writeFile(
			join(specsDir, "with-contract.json"),
			JSON.stringify({
				id: "with-contract",
				model: { role: "main" },
				toolset: "t",
				tools: ["a"],
				limits: { maxTurns: 3 },
				outputContract: { schema: "missing.schema.json" },
			}),
		);
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				id: "p",
				baseUrl: "http://127.0.0.1:1",
				apiKeyEnv: "X",
				api: "openai-completions",
				roles: {
					main: {
						provider: "p",
						modelId: "m",
						contextWindow: 1000,
						maxTokens: 100,
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				},
			}),
		);
		// 这里必须是 createDefaultRuntimeFactory() 这次 await 本身 reject —— 如果 schema 读取
		// 还留在返回的工厂函数体内,这个断言会通过(construction 不抛),而是要等真的调用
		// 工厂函数才会抛,那样就没锁住"构造期"这个时点。
		await expect(
			createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir }),
		).rejects.toThrow(/ENOENT|no such file or directory/);
	});
});

// Task 15d 复审 Critical-2 的回归锁:resolveSpecPromptPaths 的构造期调用点
// (server/main.ts 的 createDefaultRuntimeFactory 里那个 for 循环、以及 cli/main.ts 里同样的
// 调用)在这四条用例补上之前**零覆盖**——审查者的实测:把 server/main.ts 里的调用点整段删掉,
// 或把 cli/main.ts 里对应那段整段删掉,`npm test --workspace=@dfzq/task-runtime` 都是
// `382 passed | 4 skipped`,一条都不红。这里照 Minor-c(上面那个 describe)的既有范式
// ——临时 specsDir + 坏值 + `await expect(createDefaultRuntimeFactory(...)).rejects...`——
// 补上四条,不需要 MCP、不需要真实 python 解释器:createDefaultRuntimeFactory 本身在
// "构造期"这个时点完全不 spawn MCP 子进程(那要等它返回的 RuntimeFactory 真的被调用)。
//
// 顺带覆盖了审查 Important-4(appendSystemPrompt 的"字面文本"这条路此前零覆盖)与
// Important-5(appendSystemPrompt 形似路径但读不到时必须响亮失败,不能像旧判据那样静默
// 退化成字面文本——见 resolve-prompt-paths.ts 的 looksLikePath 文档)。
describe("createDefaultRuntimeFactory - systemPrompt / appendSystemPrompt resolution (Critical-2 / Important-4 / Important-5)", () => {
	// ① 坏 systemPrompt ⇒ 抛,错误含字段名。
	it("fails at construction time when systemPrompt cannot be read, not on the first run", async () => {
		const specsDir = join(root, "specs");
		await writeFile(
			join(specsDir, "bad-system-prompt.json"),
			JSON.stringify({
				id: "bad-system-prompt",
				model: { role: "main" },
				toolset: "t",
				tools: ["a"],
				limits: { maxTurns: 3 },
				systemPrompt: "missing-system-prompt.md",
			}),
		);
		const profilePath = join(root, "profile.json");
		await writeFile(profilePath, JSON.stringify(minimalProfile()));
		// 与 Minor-c 同一条纪律:必须是 createDefaultRuntimeFactory() 这次 await 本身
		// reject——如果调用点被去掉(或调用点还在但函数体被削),这个断言会失败,因为
		// 返回的 promise 根本不会 reject。错误信息必须点名 systemPrompt 这个字段,不能是
		// 一个面目全非的 ENOENT(与 resolveSpecPromptPaths 里 catch 块重新抛出的约定一致)。
		await expect(
			createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir }),
		).rejects.toThrow(/systemPrompt/);
	});

	// ② 坏 appendSystemPrompt 路径(形似路径、文件不存在)⇒ 抛,错误含字段名与坏值。
	//
	// 这条同时是审查 Important-5 的回归锁:一个长得像真实文件路径(带子目录、.md 后缀)但
	// 因为拼错/文件不存在的 appendSystemPrompt 条目,以前会被 resolve(specsDir, item) 落空
	// 后**静默**当字面文本使用——这正是本 task 要消灭的失效模式的一个变种,而出厂 spec 的
	// 输出契约(policy-query.json 的 appendSystemPrompt: ["policy-query/output-format.md"])
	// 恰好走这个字段,拼错路径会让契约悄悄从模型的 context 里消失、不报错。裁定改成:形似
	// 路径但读不到就抛,不再静默退化成字面文本。
	it("fails at construction time when an appendSystemPrompt entry looks like a path but does not exist", async () => {
		const specsDir = join(root, "specs");
		await writeFile(
			join(specsDir, "broken-append-path.json"),
			JSON.stringify({
				id: "broken-append-path",
				model: { role: "main" },
				toolset: "t",
				tools: ["a"],
				limits: { maxTurns: 3 },
				appendSystemPrompt: ["policy-query/typo-does-not-exist.md"],
			}),
		);
		const profilePath = join(root, "profile.json");
		await writeFile(profilePath, JSON.stringify(minimalProfile()));
		await expect(
			createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir }),
		).rejects.toThrow(/appendSystemPrompt.*policy-query\/typo-does-not-exist\.md/);
	});

	// ③ 字面文本 appendSystemPrompt ⇒ 不抛(brief 明确要求保住的那条路)。
	// "SOME-LITERAL" 不含 "/",也不以 .md / .json 结尾——looksLikePath() 判它不形似路径,
	// 构造期必须成功,不能因为"看起来不像一个合法路径"就报错。这条只钉"构造期不抛"这个
	// wiring 层面的事实;"这段字面文本真的进了 assembled 之后的 systemPrompt 正文"这个更细
	// 的内容层面断言在 test/policy-query-spec.test.ts 里(那边有 assemble() 的装配 harness,
	// 这里没有,也不需要为了这一条额外引入)。
	it("accepts a literal appendSystemPrompt entry that is not meant to be a file path", async () => {
		const specsDir = join(root, "specs");
		await writeFile(
			join(specsDir, "literal-append.json"),
			JSON.stringify({
				id: "literal-append",
				model: { role: "main" },
				toolset: "t",
				tools: ["a"],
				limits: { maxTurns: 3 },
				appendSystemPrompt: ["SOME-LITERAL"],
			}),
		);
		const profilePath = join(root, "profile.json");
		await writeFile(profilePath, JSON.stringify(minimalProfile()));
		const factory = await createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir });
		expect(typeof factory).toBe("function");
	});

	// ④ 正常出厂 spec(systemPrompt 与 appendSystemPrompt 都指向真实存在的文件)⇒ 不抛。
	// ①②③ 全是"某一种输入不该抛 / 该抛"的单点断言,这条是它们的对照组:两个字段都给
	// 正常值时,整条路径端到端地成功,不是"因为两条分支都被小心避开了才侥幸不抛"。
	it("succeeds at construction time for a normal spec whose systemPrompt and appendSystemPrompt both point at real files", async () => {
		const specsDir = join(root, "specs");
		await writeFile(join(specsDir, "system.md"), "系统提示正文\n");
		await writeFile(join(specsDir, "contract.md"), "契约正文\n");
		await writeFile(
			join(specsDir, "normal.json"),
			JSON.stringify({
				id: "normal",
				model: { role: "main" },
				toolset: "t",
				tools: ["a"],
				limits: { maxTurns: 3 },
				systemPrompt: "system.md",
				appendSystemPrompt: ["contract.md"],
			}),
		);
		const profilePath = join(root, "profile.json");
		await writeFile(profilePath, JSON.stringify(minimalProfile()));
		const factory = await createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir });
		expect(typeof factory).toBe("function");
	});
});

// Task 4 复审 I-1 的回归锁:resolve-prompt-paths.ts 里 fastPath 三个 prompt 字段的解析分支,
// 在这条用例补上之前**零覆盖**——test/spec.test.ts 的 fastPath 用例全部直接调 validateSpec,
// 不经过 resolveSpecPromptPaths;把 resolve-prompt-paths.ts 里 fastPath 那段解析代码整段删掉,
// npm test --workspace=@dfzq/task-runtime 一条都不会红(与上面 Critical-2 那条回归锁守的是同一
// 类型的坑,只是换了 spec.systemPrompt / spec.fastPath 两个不同字段)。这里照上面
// "①坏 systemPrompt" 那条用例的同一范式补上,断在生产调用点(server/main.ts:163 的
// resolveSpecPromptPaths),不是直接调 resolveSpecPromptPaths 函数本身。
describe("createDefaultRuntimeFactory - fastPath prompt resolution (Task 4 复审 I-1)", () => {
	it("fails at construction time when fastPath.answerPrompt cannot be read, not on the first run", async () => {
		const specsDir = join(root, "specs");
		// systemPrompt / rewritePrompt 都指向真实存在的文件——只让 answerPrompt 触发失败,
		// 这样断言的 /fastPath\.answerPrompt/ 才是精确定位到那一个字段,不是三选一撞上的。
		await writeFile(join(specsDir, "fp-system.md"), "快路径 system prompt 正文\n");
		await writeFile(join(specsDir, "fp-rewrite.md"), "快路径改写 prompt 正文\n");
		await writeFile(
			join(specsDir, "bad-fastpath-answer-prompt.json"),
			JSON.stringify({
				id: "bad-fastpath-answer-prompt",
				model: { role: "main" },
				toolset: "t",
				tools: ["a"],
				limits: { maxTurns: 3 },
				fastPath: {
					enabled: true,
					systemPrompt: "fp-system.md",
					rewritePrompt: "fp-rewrite.md",
					answerPrompt: "missing-fp-answer.md",
					maxClauses: 12,
					limits: { runTimeoutMs: 5000 },
				},
			}),
		);
		const profilePath = join(root, "profile.json");
		await writeFile(profilePath, JSON.stringify(minimalProfile()));
		await expect(
			createDefaultRuntimeFactory({ profilePath, workRoot: join(root, "work"), specsDir }),
		).rejects.toThrow(/fastPath\.answerPrompt/);
	});
});

// 以下用例来自评审对 main.ts 的复审(Critical + Important),补在 brief 逐字采用的
// describe("server startup", ...) 之外,不动上面那段。
describe("server shutdown safety", () => {
	it(
		"rejects instead of hanging forever when the port is already in use",
		async () => {
			// 先用裸 net server 占住一个端口,复现 EADDRINUSE ——这是唯一能让
			// @hono/node-server 的 serve() 触发 "error" 而不是 "listening" 的现实场景。
			const occupied = createServer();
			await new Promise<void>((resolve, reject) => {
				occupied.once("error", reject);
				occupied.listen(0, "127.0.0.1", () => resolve());
			});
			const occupiedAddress = occupied.address();
			if (typeof occupiedAddress !== "object" || !occupiedAddress) {
				throw new Error("failed to bind probe port");
			}
			const port = occupiedAddress.port;

			// 判别力护栏:若 startServer() 内部漏掉 once("error", reject),这个调用会一直
			// 挂到 CASE_TIMEOUT_MS 超时才被 vitest 判失败,而不是立刻拿到 EADDRINUSE——
			// 用全局 uncaughtException 兜底确认"不会崩进程",用 rejects 确认"确实响亮失败"。
			let uncaught: unknown;
			const onUncaughtException = (error: unknown) => {
				uncaught = error;
			};
			process.once("uncaughtException", onUncaughtException);

			try {
				await expect(
					startServer({
						port,
						dbPath: join(root, "runs.db"),
						specsDir: join(root, "specs"),
						internalToken: "t",
						runtimeFactory: async () => createStubRuntime(),
					}),
				).rejects.toThrow(/EADDRINUSE/);
			} finally {
				process.off("uncaughtException", onUncaughtException);
				await new Promise<void>((resolve) => occupied.close(() => resolve()));
			}

			expect(uncaught).toBeUndefined();
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"close() is idempotent",
		async () => {
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			await server.close();
			// 第二次调用不该抛——close() 必须和 store.close()(见 store/sqlite.ts)同一条
			// "安全重入"纪律,否则调用方(以及测试的 afterEach)重复 close 一次就会撞
			// ERR_SERVER_NOT_RUNNING。
			await expect(server.close()).resolves.toBeUndefined();
			stop = server.close; // 第三次(afterEach 里)也不该抛,顺手验证幂等性不是"只对两次生效"。
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"warns instead of silently dropping results when closing with a run still in flight",
		async () => {
			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime({ hang: true }),
			});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const submit = await fetch(`http://127.0.0.1:${server.port}/runs`, {
				method: "POST",
				headers: { "content-type": "application/json", "X-Internal-Token": "t" },
				body: JSON.stringify({
					taskKind: "demo",
					input: "x",
					clientRequestId: "hang-1",
					filters: { corpusTypes: ["internal"] },
					waitMs: 50,
				}),
				signal: AbortSignal.timeout(5_000),
			});
			// hang 的 run 不会在 50ms 等待窗口内完成,竞速输给计时器,回 202 running。
			expect(submit.status).toBe(202);

			await server.close();
			stop = undefined; // 已经关过了,afterEach 不用再关一次

			expect(errorSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("still in flight"))).toBe(
				true,
			);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"runs recoverStaleRuns before the socket starts listening, not merely before startServer() resolves",
		async () => {
			// 只证明"port:0 场景下二者顺序恰好一致"证不了什么:recoverStaleRuns 是同步调用,
			// 只要仍在 return 之前,把它挪到 await serve(...) 之后,这个用例照样会通过——
			// 它只验证了"恢复早于 startServer() 返回",证不了"恢复早于 socket 开始监听"。
			// 用固定端口时二者的差别是真实风险(调用方可能在 resolve 前就抢先连上)。
			// 这里对 store.recoverStaleRuns 与 net.Server.prototype.listen 各插一个 spy,把
			// 触发顺序记进共享数组,直接断言调用序,不依赖网络竞速。
			const order: string[] = [];
			const originalCreate = sqliteModule.createSqliteRunStore;
			vi.spyOn(sqliteModule, "createSqliteRunStore").mockImplementation((path: string) => {
				const created = originalCreate(path);
				const originalRecover = created.recoverStaleRuns.bind(created);
				created.recoverStaleRuns = (now: number) => {
					order.push("recover");
					return originalRecover(now);
				};
				return created;
			});
			const originalListen = Server.prototype.listen as unknown as (...args: unknown[]) => Server;
			vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
				order.push("listen");
				return originalListen.apply(this, args);
			});

			const server = await startServer({
				port: 0,
				dbPath: join(root, "runs.db"),
				specsDir: join(root, "specs"),
				internalToken: "t",
				runtimeFactory: async () => createStubRuntime(),
			});
			stop = server.close;

			expect(order.indexOf("recover")).toBeGreaterThanOrEqual(0);
			expect(order.indexOf("listen")).toBeGreaterThanOrEqual(0);
			expect(order.indexOf("recover")).toBeLessThan(order.indexOf("listen"));
		},
		CASE_TIMEOUT_MS,
	);
});
