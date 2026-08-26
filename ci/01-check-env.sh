#!/usr/bin/env bash
# 01-check-env.sh —— 环境自检:docker / compose / JFrog 登录 / BASE_TAG / 版本留痕。
source "$(dirname "$0")/lib.sh"

log "=== docker ==="
docker version

mkdir -p .ci
# 🔴 清掉上一版流水线可能留在 workspace 里的旧 junit 报告(2026-08-26 首跑实测:
#    stage 3 被跳过时,post 的 junit 捡到 1 天前的旧文件,报一条
#    "Test reports were found but none of them are new" 的糊涂错)。
rm -f .ci/junit-*.xml

log "=== docker-compose ==="
rm -f .ci/compose-cmd            # 强制重探,不吃上次构建的缓存
COMPOSE="$(compose_cmd)"
echo "$COMPOSE" > .ci/compose-cmd
log "compose 命令:${COMPOSE}"
$COMPOSE version

log "=== 底座 tag ==="
require_base_tag
log "BASE_TAG=${BASE_TAG}"
log "REGISTRY=${REGISTRY}"

log "=== JFrog 登录状态 ==="
# docker info 不打印第三方 registry 的登录状态,真正能查的是凭证有没有存进
# docker 的 config.json。⚠ 这只证明「存过凭证」,不证明此刻仍有效 ——
# 那由 stage 3 真去 pull 底座镜像时验证,不在这里假装验过。
REGISTRY_HOST="${REGISTRY%%/*}"
DOCKER_CFG="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
[ -f "$DOCKER_CFG" ] || die "找不到 ${DOCKER_CFG} —— 先在本机执行:docker login ${REGISTRY_HOST}"
grep -q "$REGISTRY_HOST" "$DOCKER_CFG" \
  || die "${DOCKER_CFG} 里没有 ${REGISTRY_HOST} 的凭证条目 —— 先执行:docker login ${REGISTRY_HOST}
  (报 x509 的话:/etc/docker/daemon.json 配 insecure-registries 或装内网 CA,见交接文档 §3-B)"
log "✓ ${REGISTRY_HOST} 的凭证已在 ${DOCKER_CFG} 里"

log "=== 本次构建的版本 ==="
# Jenkins 给 GIT_COMMIT/GIT_BRANCH;手工跑时从 git 现取,两边都能留痕。
_commit="${GIT_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
_branch="${GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
printf 'commit=%s\nbranch=%s\nbuild=%s\nbase_tag=%s\n' \
  "$_commit" "$_branch" "${BUILD_TAG:-manual}" "$BASE_TAG" > .ci/BUILD_INFO
cat .ci/BUILD_INFO
