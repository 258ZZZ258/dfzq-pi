#!/usr/bin/env bash
# 在构建机(pi 运行的那台 Linux)上执行的真实构建。
#
# 代码**由主节点 rsync 过来**,不在这里 clone —— 主节点跑 Pipeline script from SCM 时
# 本来就已经检出了,复用它;构建机因此**不需要 Git 访问、不需要 Git 凭证**。
#
# 由 Jenkinsfile 经 `ssh host "VAR=... bash -s" < ci/remote-build.sh` 喂进来,
# 所以这里不需要任何嵌套引号 —— 它就是一个普通 bash 脚本,可以在构建机上单独手工跑。
#
# 入参:
#   REMOTE_DIR    代码所在目录(rsync 的目标)
#   NODE_HOME     Node 解包路径
#   NPM_REGISTRY  可选,内网 npm 镜像
set -euo pipefail

export PATH="${NODE_HOME}/bin:${PATH}"
cd "$REMOTE_DIR"

echo "=== 本次构建的版本 ==="
cat .ci/BUILD_INFO 2>/dev/null || echo "(无 BUILD_INFO)"

echo "=== 环境自检 ==="
command -v node >/dev/null || { echo "✗ node 不在 PATH:${NODE_HOME}/bin"; exit 1; }
node -v && npm -v
node -e 'const m=+process.versions.node.split(".")[0]; if(m<22){console.error("需要 Node >= 22.19.0,当前 "+process.versions.node);process.exit(1)}'

echo "=== providers/data 自检 ==="
# 该目录由 hydrate:model-data 联网生成,内网分支里是提交进版本库的;
# 缺了会让 packages/ai 的 14 个测试文件加载失败,症状是一串 Cannot find module './data/*.json'
test -d packages/ai/src/providers/data || { echo "✗ 缺 providers/data —— 主节点检出的不是 dfzq/intranet 分支?"; exit 1; }
echo "providers/data: $(ls packages/ai/src/providers/data | wc -l) 个文件"

echo "=== 装依赖 ==="
# --ignore-scripts:跳过 husky(prepare)与 canvas 的 node-gyp,两者在 CI 里都会失败
if [ -n "${NPM_REGISTRY:-}" ]; then
  npm ci --ignore-scripts --registry "$NPM_REGISTRY"
else
  npm ci --ignore-scripts
fi
# 脚本 exit 0 不等于装上了 —— postgres 是 task-runtime 的运行期依赖,单独确认
test -d node_modules/postgres || { echo "✗ postgres 未装上(内网 npm 镜像里可能没有)"; exit 1; }

echo "=== 类型与契约检查 ==="
# 🔴 这里**刻意不跑 `npm run check`** —— 它的第一条是 biome,而 biome 的预编译二进制
#    要 glibc >= 2.30,构建机是 Kylin V10 / glibc 2.28(恰好也是 Milvus 的下限)。
#    症状:`libc.so.6: version 'GLIBC_2.29' not found`。这是**环境硬约束,不是配置问题**。
#
#    ⚠ 因此**格式检查只在外网门禁把关**(那边 `npm run check` 是绿的),内网 CI 不重复。
#      这条与既定纪律一致:代码改动一律在外网做,内网只拉不改。
#
#    下面六条是 `npm run check` 里除 biome 之外的全部内容,逐条跑 —— set -e 保证任一失败即停。
npm run check:pinned-deps
npm run check:ts-imports
npm run check:shrinkwrap
npm run check:install-lock:coding-agent
npx tsgo --noEmit
npm run check:browser-smoke

echo "=== 测试 ==="
# 🔴 拆两条,而不是排掉 serve-cli.test.ts 整个文件:
#    「serves a real request end to end」会 spawn serve,而 createPostgresRunStore
#    启动即 SELECT 1(store/postgres.ts:68)—— 它真的需要活的 PostgreSQL,CI 里没有。
#    但同文件另外两条是「没 token / 空 token 拒绝启动」的安全断言,不能跟着丢。
#    两条合计 773 passed,与全量跑的通过数一致。
#    ⚠ 后续给 CI 挂上 PG 之后应改回整包跑,并删掉这段特例。
mkdir -p .ci
cd packages/task-runtime
npx vitest --run --exclude 'test/serve-cli.test.ts' \
    --reporter=default --reporter=junit --outputFile=../../.ci/junit-main.xml
npx vitest --run test/serve-cli.test.ts -t 'refuses to start' \
    --reporter=default --reporter=junit --outputFile=../../.ci/junit-serve-cli.xml

echo "=== 构建完成 ==="
