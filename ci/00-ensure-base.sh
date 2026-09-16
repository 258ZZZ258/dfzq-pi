#!/usr/bin/env bash
# 00-ensure-base.sh —— 确保当前 audit-ai 内容对应的 L1 底座存在,不存在就现造现推。
#
# 🔴 2026-09-16 起 audit-ai **内嵌在本仓 services/audit-ai/**(随 main 重构而来):
#    不再 clone 外部仓,DFZQ_AUDIT_AI_GIT 作废(设了也忽略)。
#    tag = `git log -1 --format=%h -- services/audit-ai`(该目录最后一次变动的 sha)——
#    audit-ai 没动就复用旧底座,动了自动重造,全程零人工。
#    结果写 .ci/BASE_TAG,后续 stage(02/03/04)自动读。
source "$(dirname "$0")/lib.sh"
mkdir -p .ci

[ -d services/audit-ai ] || die "本仓没有 services/audit-ai —— 检出的分支对吗?(该目录随 2026-09 的 main 重构并入)"
[ -z "${DFZQ_AUDIT_AI_GIT:-}" ] || log "⚠ DFZQ_AUDIT_AI_GIT 已作废(audit-ai 内嵌),忽略该变量,可从 Jenkins 全局配置删除"

SHA="$( (git log -1 --format=%h -- services/audit-ai) )"
[ -n "$SHA" ] || die "services/audit-ai 无提交记录?"
IMG="${REGISTRY}/dfzq-pi-base:${SHA}"
log "services/audit-ai@${SHA} → 底座应为 ${IMG}"

if docker image inspect "$IMG" >/dev/null 2>&1 \
   || DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "$IMG" >/dev/null 2>&1; then
  log "✓ 底座已存在(本地或 registry),跳过构建"
else
  RB="${REGISTRY}/dfzq-runtime-base:${RUNTIME_BASE_TAG}"
  docker image inspect "$RB" >/dev/null 2>&1 || docker pull "$RB" \
    || die "L0 不存在:${RB} —— 它是唯一必须外网构建的层(内网无 Debian 仓)。
  外网:PLATFORM=linux/amd64 ./deploy/build.sh --runtime-base → docker save 搬入 → load + push"
  log "底座不存在,现造(pip 走 PIP_INDEX_URL=${PIP_INDEX_URL:-<未设,公网>})…"
  BASE_TAG="$SHA" RUNTIME_BASE_TAG="$RUNTIME_BASE_TAG" REGISTRY="$REGISTRY" \
    PIP_INDEX_URL="${PIP_INDEX_URL:-}" PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-}" \
    bash deploy/build.sh --base
  # BASE_PUSH=0 供本机自测(REGISTRY=local 没有真 registry 可推);CI 缺省推
  if [ "${BASE_PUSH:-1}" = "1" ]; then docker push "$IMG"; else log "BASE_PUSH=0,跳过 push"; fi
fi
echo "$SHA" > .ci/BASE_TAG
log "BASE_TAG=${SHA}(已写入 .ci/BASE_TAG,后续 stage 自动读取)"
