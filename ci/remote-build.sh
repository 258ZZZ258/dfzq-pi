#!/usr/bin/env bash
# 在构建机(pi 运行的那台 Linux)上执行的真实构建。
# 由 Jenkinsfile 经 `ssh host "VAR=... bash -s" < ci/remote-build.sh` 喂进来,
# 所以这里**不需要**任何嵌套引号 —— 它就是一个普通 bash 脚本。
#
# 入参(由 Jenkinsfile 通过 ssh 命令行的 VAR=... 传):
#   GIT_URL     内网 Git 仓地址
#   GIT_COMMIT  本次要构建的精确 commit(不是分支名 —— 否则构建的不是 Jenkins 说的那一版)
#   REMOTE_DIR  构建机上的工作目录
#   NODE_HOME   Node 解包路径
#   NPM_REGISTRY 可选,内网 npm 镜像
set -euo pipefail

export PATH="${NODE_HOME}/bin:${PATH}"

echo "=== 环境自检 ==="
command -v node >/dev/null || { echo "✗ node 不在 PATH:${NODE_HOME}/bin"; exit 1; }
node -v && npm -v
node -e 'const m=+process.versions.node.split(".")[0]; if(m<22){console.error("需要 Node >= 22.19.0,当前 "+process.versions.node);process.exit(1)}'

echo "=== 取代码到 ${GIT_COMMIT} ==="
mkdir -p "$(dirname "$REMOTE_DIR")"
if [ -d "${REMOTE_DIR}/.git" ]; then
  cd "$REMOTE_DIR" && git fetch --prune origin
else
  git clone "$GIT_URL" "$REMOTE_DIR" && cd "$REMOTE_DIR"
fi
git checkout -f "$GIT_COMMIT"
# 清掉上次构建的残留,但**保留 node_modules**(重装一次要几分钟)
git clean -ffd -e node_modules -e .ci
git log --oneline -1

echo "=== providers/data 自检 ==="
# 该目录由 hydrate:model-data 联网生成,内网分支里是提交进版本库的;缺了会让 14 个测试文件加载失败
test -d packages/ai/src/providers/data || { echo "✗ 缺 providers/data —— 检出的不是 dfzq/intranet 分支?"; exit 1; }
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

echo "=== 格式与类型检查 ==="
npm run check

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
