#!/usr/bin/env bash
# 04-build-image.sh —— 构建交付镜像(runtime 阶段),tag = git sha 前 7 位。
source "$(dirname "$0")/lib.sh"
require_base_tag

# tag = git sha 前 7 位(D-11:不锁 digest,只用不可变 tag)。
# build.sh 自己也这么算;这里算一遍是为了 05/06 拼 PI_IMAGE,并与 Jenkins 的
# GIT_COMMIT 一并留痕 —— 两者对不上时一眼看得出来。
SHORT_SHA="$(git rev-parse --short=7 HEAD)"
log "GIT_COMMIT=${GIT_COMMIT:-<手工跑>}  →  tag=${SHORT_SHA}"
mkdir -p .ci && echo "$SHORT_SHA" > .ci/SHORT_SHA

REGISTRY="$REGISTRY" BASE_TAG="$BASE_TAG" NPM_REGISTRY="${NPM_REGISTRY:-}" \
  bash deploy/build.sh
docker image inspect "${REGISTRY}/dfzq-pi:${SHORT_SHA}" \
  -f '交付镜像 {{.RepoTags}} created={{.Created}}'
