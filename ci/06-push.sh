#!/usr/bin/env bash
# 06-push.sh —— 推交付镜像。只在 dfzq/intranet 分支上推(手工跑也守这条)。
source "$(dirname "$0")/lib.sh"

SHORT_SHA="$(cat .ci/SHORT_SHA 2>/dev/null || true)"
[ -n "$SHORT_SHA" ] || die "缺 .ci/SHORT_SHA —— 先跑 ci/04-build-image.sh"

# 分支门:Jenkins 的 when 已挡过一道,这里再守一道是给**手工跑**用的 ——
# 「没排练过的镜像进不了 registry」这条纪律不因绕开 Jenkins 而失效。
# 确要例外(比如热修)显式 CI_PUSH_FORCE=1,留痕在敲命令的人手里。
_branch="${BRANCH_NAME:-${GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}}"
case "$_branch" in
  dfzq/intranet|*/dfzq/intranet) : ;;
  *) [ "${CI_PUSH_FORCE:-0}" = "1" ] \
       || die "当前分支是 ${_branch},不是 dfzq/intranet —— 不推。确要推:CI_PUSH_FORCE=1 bash ci/06-push.sh" ;;
esac

docker push "${REGISTRY}/dfzq-pi:${SHORT_SHA}"
# latest-intranet:给「随便给我一个能跑的最新版」用。🔴 它是**可变** tag,只作便利
# 别名 —— compose 的 PI_IMAGE 一律用 sha tag,回滚才有确定的目标(D-11)。
docker tag  "${REGISTRY}/dfzq-pi:${SHORT_SHA}" "${REGISTRY}/dfzq-pi:latest-intranet"
docker push "${REGISTRY}/dfzq-pi:latest-intranet"
log "✓ 已推:${REGISTRY}/dfzq-pi:${SHORT_SHA}(另打 latest-intranet)"
