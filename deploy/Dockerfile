# dfzq-pi 薄层镜像 —— 三阶段:deps → test → runtime
#
# 规格:dfzq-pi开发任务/骨架/规格-容器化与一键部署.md §2.2
# 构建上下文 = dfzq-pi 仓根(audit-ai 只在底座里,这里不需要)。
# 多阶段与 --target 在 Docker 19.03 上可用(17.05 起),不受目标机老版本限制。

ARG REGISTRY=jfrog.orientsec.com.cn/dev7-docker-release-local
ARG BASE_TAG

# ============================================================
# 阶段 deps —— 装全量依赖(含 devDependencies)
# ============================================================
FROM ${REGISTRY}/dfzq-pi-base:${BASE_TAG} AS deps
WORKDIR /app

# 🔴 **不能**用 `COPY packages/*/package.json ./packages/` 做"先拷清单再装依赖"的缓存优化:
#    Docker 的 COPY 通配符会**展平路径**,8 个同名 package.json 互相覆盖只剩一个。
#    且根 package.json 的 workspaces 不止 `packages/*`,还含 `packages/storage/*` 与
#    `packages/coding-agent/examples/extensions/` 下 5 个 —— npm ci 需要它们**全部**在场。
#    ⇒ 整树 COPY 后再装。代价:改一行 TS 会让 npm ci 层失效、重装一次 node_modules。
#    缓解:重的东西(venv、系统包、apt)都在底座里,这里重装的只是 node_modules。
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json biome.json vitest.base.ts ./
COPY packages/ ./packages/
# 🔴 scripts/ 是六条 check 的实现所在(check:pinned-deps → scripts/check-pinned-deps.mjs 等)。
#    漏了它 test 阶段第一条就 `Cannot find module '/app/scripts/check-pinned-deps.mjs'`(实测)。
#    runtime 阶段不 COPY 它 —— 交付镜像不跑 check,保持精简。
COPY scripts/ ./scripts/

ARG NPM_REGISTRY=
# 🔴 --ignore-scripts:跳过 husky(prepare)与 canvas 的 node-gyp,两者在 CI 里都会失败
RUN if [ -n "$NPM_REGISTRY" ]; then \
      npm ci --ignore-scripts --registry "$NPM_REGISTRY"; \
    else \
      npm ci --ignore-scripts; \
    fi

# ============================================================
# 阶段 test —— CI 用 --target test 停在这
# ============================================================
FROM deps AS test

# 🔴 刻意不跑 `npm run check` 的第一条 biome:格式检查已在外网门禁把关,
#    内网不重复(承 ci/remote-build.sh 既有纪律)。下面六条是 check 的其余全部内容。
RUN npm run check:pinned-deps \
 && npm run check:ts-imports \
 && npm run check:shrinkwrap \
 && npm run check:install-lock:coding-agent \
 && npx tsgo --noEmit \
 && npm run check:browser-smoke

# 🔴 vitest 拆两条,不是一条 —— 承 ci/remote-build.sh 的既有处置:
#    test/serve-cli.test.ts 的「serves a real request end to end」会 spawn serve,而
#    createPostgresRunStore 启动即 SELECT 1(store/postgres.ts:68),本阶段**没有活的 PG**。
#    但同文件另外两条是「没 token / 空 token 拒绝启动」的安全断言,不能跟着丢。
#    ⚠ 后续项:排练栈里有活 PG,可把这条整包跑起来并删掉本特例。
RUN mkdir -p /out && cd packages/task-runtime \
 && npx vitest --run --exclude 'test/serve-cli.test.ts' \
        --reporter=default --reporter=junit --outputFile=/out/junit-main.xml \
 && npx vitest --run test/serve-cli.test.ts -t 'refuses to start' \
        --reporter=default --reporter=junit --outputFile=/out/junit-serve-cli.xml

# ============================================================
# 阶段 runtime —— 交付镜像
# ============================================================
FROM ${REGISTRY}/dfzq-pi-base:${BASE_TAG} AS runtime
WORKDIR /app

COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/

ARG NPM_REGISTRY=
# 🔴 --omit=dev --ignore-scripts:现场报告 §4.4 的结论固化。
#    不加 --omit=dev 会装 canvas(packages/ai 的 devDependency,原生模块,构建失败)。
#    ⚠ 刻意**不从 deps 阶段 COPY node_modules** —— 那份含 devDependencies,
#      交付镜像要的是 --omit=dev 的那一份,必须独立装。
RUN if [ -n "$NPM_REGISTRY" ]; then \
      npm ci --omit=dev --ignore-scripts --registry "$NPM_REGISTRY"; \
    else \
      npm ci --omit=dev --ignore-scripts; \
    fi

COPY deploy/entrypoint.sh deploy/init.sh /app/deploy/
RUN chmod +x /app/deploy/entrypoint.sh /app/deploy/init.sh

# 🔴 构建期断言,搬自 ci/remote-build.sh 的两条运行期自检 —— 让"装配不全"在构建期就红
RUN test -d node_modules/postgres \
      || { echo "✗ postgres 未装上(task-runtime 的运行期依赖)"; exit 1; } \
 && test -d packages/ai/src/providers/data \
      || { echo "✗ 缺 providers/data —— 构建的不是 dfzq/intranet 分支?"; exit 1; }

ENV TASK_RUNTIME_SPECS_DIR=/app/packages/task-runtime/specs \
    TASK_RUNTIME_PROFILE=/data/config/gateway.json \
    TASK_RUNTIME_WORK_ROOT=/data/work \
    POLICY_MCP_AUDIT_LOG=/data/logs/policy-mcp-audit.jsonl \
    TASK_RUNTIME_PORT=18080

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD curl -fsS "http://127.0.0.1:${TASK_RUNTIME_PORT}/healthz" \
      | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || exit 1

# 🔴 serve 入口是 cli/main.ts serve,不是 cli/serve.ts,也不能用 run --spec 代替
#    (那条路径给 createMcpToolset 传的 scope 是字面 null,C1 会拒每次工具调用)。
#    真正的 exec 在 entrypoint.sh 末尾。
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
