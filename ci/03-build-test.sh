#!/usr/bin/env bash
# 03-build-test.sh —— 构建 test 阶段镜像并在容器内跑六条 check + tsgo + vitest。
#
# --target test:检查与单测全在容器内跑(D-12)。主节点没有 Node,这些**只能**在
# 容器内跑;交付镜像走 --omit=dev 也不含 vitest,所以 test 是独立的一个构建阶段。
# build.sh 跑完会 docker cp 出 /out/junit-*.xml 到 <repo>/.ci/。
source "$(dirname "$0")/lib.sh"
require_base_tag

rm -f .ci/junit-*.xml
REGISTRY="$REGISTRY" BASE_TAG="$BASE_TAG" NPM_REGISTRY="${NPM_REGISTRY:-}" \
  bash deploy/build.sh --test

log "=== 取回的测试报告 ==="
find .ci -name 'junit-*.xml' -print
# 🔴「没有测试报告就该是红的」这条纪律由本脚本守 —— 在这里响亮失败,
#    而不是等 post 的 junit 步骤才含糊地报「没有测试」。
test -n "$(find .ci -name 'junit-*.xml' -print -quit)" \
  || die "没有取到任何 junit 报告 —— test 阶段真的跑到了吗?"
