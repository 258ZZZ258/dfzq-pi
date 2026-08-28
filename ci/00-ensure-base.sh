#!/usr/bin/env bash
# 00-ensure-base.sh —— 确保 audit-ai 对应版本的 L1 底座存在,不存在就现造现推。
#
# 🔴 三层改造(2026-08-28)后,DFZQ_BASE_TAG 不再需要人工维护:本脚本 checkout
#    内网 Git 上的 audit-ai,tag = 其 sha7;JFrog 里已有就跳过,没有就在本机构建
#    (pip 走内网 Artifactory 的 PIP_INDEX_URL)并 push。结果写进 .ci/BASE_TAG,
#    后续脚本(02/03/04)自动读它。
#
# 来源三选一(优先级从高到低):
#   DFZQ_AUDIT_AI_GIT   内网 Git 的 audit-ai 仓地址(Jenkins 全局变量;CI 的正路)
#   AUDIT_AI_ROOT       本地 audit-ai 工作树(开发机手工跑)
#   都没有              退回老行为:要求 BASE_TAG/DFZQ_BASE_TAG 已设(过渡期兜底)
source "$(dirname "$0")/lib.sh"
mkdir -p .ci

if [ -n "${DFZQ_AUDIT_AI_GIT:-}" ]; then
  log "从内网 Git checkout audit-ai:${DFZQ_AUDIT_AI_GIT}(分支 ${DFZQ_AUDIT_AI_BRANCH:-main})"
  rm -rf .ci/audit-ai
  git clone --depth 1 -b "${DFZQ_AUDIT_AI_BRANCH:-main}" "$DFZQ_AUDIT_AI_GIT" .ci/audit-ai
  AUDIT_AI_ROOT="$PWD/.ci/audit-ai"
elif [ -n "${AUDIT_AI_ROOT:-}" ] && [ -d "$AUDIT_AI_ROOT" ]; then
  log "用本地 audit-ai 工作树:${AUDIT_AI_ROOT}"
else
  # 🔴 兜底只认**显式给的** BASE_TAG(env),不吃上一次构建残留的 .ci/BASE_TAG ——
  #    残留值会把"配置缺失"伪装成"一切正常",静默用旧底座。
  [ "$BASE_TAG_FROM_FILE" = "0" ] && [ -n "$BASE_TAG" ] \
    || die "三选一都没给:DFZQ_AUDIT_AI_GIT(CI 正路)/ AUDIT_AI_ROOT(手工)/ 显式 BASE_TAG(过渡期兜底)"
  log "无 audit-ai 来源,沿用给定的 BASE_TAG=${BASE_TAG}(过渡期兜底)"
  echo "$BASE_TAG" > .ci/BASE_TAG
  exit 0
fi

SHA="$( (cd "$AUDIT_AI_ROOT" && git rev-parse --short=7 HEAD) )"
IMG="${REGISTRY}/dfzq-pi-base:${SHA}"
log "audit-ai@${SHA} → 底座应为 ${IMG}"

if docker image inspect "$IMG" >/dev/null 2>&1 \
   || DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "$IMG" >/dev/null 2>&1; then
  log "✓ 底座已存在(本地或 registry),跳过构建"
else
  RB="${REGISTRY}/dfzq-runtime-base:${RUNTIME_BASE_TAG}"
  docker image inspect "$RB" >/dev/null 2>&1 || docker pull "$RB" \
    || die "L0 不存在:${RB} —— 它是唯一必须外网构建的层(内网无 Debian 仓)。
  外网:PLATFORM=linux/amd64 ./deploy/build.sh --runtime-base → docker save 搬入 → load + push"
  log "底座不存在,现造(pip 走 PIP_INDEX_URL=${PIP_INDEX_URL:-<未设,公网>})…"
  AUDIT_AI_ROOT="$AUDIT_AI_ROOT" BASE_TAG="$SHA" RUNTIME_BASE_TAG="$RUNTIME_BASE_TAG" \
    REGISTRY="$REGISTRY" PIP_INDEX_URL="${PIP_INDEX_URL:-}" PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-}" \
    bash deploy/build.sh --base
  # BASE_PUSH=0 供本机自测(REGISTRY=local 没有真 registry 可推);CI 缺省推
  if [ "${BASE_PUSH:-1}" = "1" ]; then docker push "$IMG"; else log "BASE_PUSH=0,跳过 push"; fi
fi
echo "$SHA" > .ci/BASE_TAG
log "BASE_TAG=${SHA}(已写入 .ci/BASE_TAG,后续 stage 自动读取)"
