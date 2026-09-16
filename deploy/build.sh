#!/usr/bin/env bash
# build.sh —— 构建 dfzq-pi 的底座 / 测试 / 交付三种镜像
#
# 规格:dfzq-pi开发任务/骨架/规格-容器化与一键部署.md §2.3
#
#   build.sh --runtime-base  构建 L0(node + apt;唯一必须外网构建的层)
#   build.sh --base          构建 L1(audit-ai 源码 + venv;内网外网都能造)
#   build.sh --test          构建到 test 阶段并跑检查与单测,取回 junit
#   build.sh                 构建 runtime 阶段,tag = 当前 git sha 前 7 位
#   build.sh --push          构建后推 registry
#   build.sh --dry-run       只打印将执行的命令
#
# 环境变量:
#   REGISTRY          缺省 jfrog.orientsec.com.cn/dev7-docker-release-local
#   RUNTIME_BASE_TAG  L0 的 tag,缺省 node22-r1(人工递增,改缺省值走 git)
#   BASE_TAG          薄层 FROM 的 L1 tag;--base 时是要打的 tag(缺省 = audit-ai sha7)
#   AUDIT_AI_ROOT   audit-ai 工作树,缺省 ../../dfzq-audit-ai
#   PLATFORM        缺省空(用本机架构);交付内网须显式 linux/amd64
#   NPM_REGISTRY / PIP_INDEX_URL / PIP_TRUSTED_HOST   内网源,透传给构建
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

REGISTRY="${REGISTRY:-jfrog.orientsec.com.cn/dev7-docker-release-local}"
AUDIT_AI_ROOT="${AUDIT_AI_ROOT:-$(cd "$REPO_ROOT/../dfzq-audit-ai" 2>/dev/null && pwd || echo "")}"
PLATFORM="${PLATFORM:-}"

MODE="runtime"; DRY=0; PUSH=0
RUNTIME_BASE_TAG="${RUNTIME_BASE_TAG:-node22-r1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime-base) MODE="runtime-base" ;;
    --base) MODE="base" ;;
    --test) MODE="test" ;;
    --push) PUSH=1 ;;
    --dry-run) DRY=1 ;;
    --platform) PLATFORM="$2"; shift ;;
    --audit-ai) AUDIT_AI_ROOT="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数:$1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[build] %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

# 🔴 bash 3.2(macOS 自带)在 set -u 下展开**空数组**会报 unbound variable。
# 全仓统一用 ${arr[@]+"${arr[@]}"} 这个安全习惯用法展开,见 dfzq-predeploy/scripts/lib.sh 顶部。
PLATFORM_ARGS=()
[ -n "$PLATFORM" ] && PLATFORM_ARGS=(--platform "$PLATFORM")

# ---- L0 runtime-base(node + apt;唯一必须外网构建的层)---------------------
if [ "$MODE" = "runtime-base" ]; then
  HOST_ARCH="$(uname -m)"
  if [ -z "$PLATFORM" ] && [ "$HOST_ARCH" != "x86_64" ] && [ "$HOST_ARCH" != "amd64" ]; then
    echo "✗ 本机是 ${HOST_ARCH},交付内网请显式:PLATFORM=linux/amd64 $0 --runtime-base" >&2
    echo "  本机自测:PLATFORM=linux/$(uname -m) $0 --runtime-base" >&2
    exit 1
  fi
  IMAGE="${REGISTRY}/dfzq-runtime-base:${RUNTIME_BASE_TAG}"
  log "构建 L0:$IMAGE${PLATFORM:+($PLATFORM)}"
  run docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} \
      -f "$HERE/Dockerfile.runtime-base" \
      ${APT_MIRROR:+--build-arg "APT_MIRROR=$APT_MIRROR"} \
      ${NODE_BASE:+--build-arg "NODE_BASE=$NODE_BASE"} \
      -t "$IMAGE" "$HERE"
  [ "$PUSH" = 1 ] && run docker push "$IMAGE"
  log "完成:$IMAGE"
  exit 0
fi

# ---- L1 底座(audit-ai 源码 + venv)-----------------------------------------
if [ "$MODE" = "base" ]; then
  # 🔴 2026-09-16:audit-ai 已内嵌 services/audit-ai,不再需要外部工作树。

  # 🔴 架构守卫:交付目标是 amd64(Kylin V10 / x86_64)。在 arm64 机器(Apple Silicon)
  #    上不指定 --platform 就 build,产出的是 arm64 镜像 —— 推到内网后 pull 得下来、
  #    但一起就报 `exec format error` 或 `exec /bin/sh: exec format error`,
  #    而 docker 不会提前告诉你架构不对。这里在**构建前**就拦住。
  HOST_ARCH="$(uname -m)"
  if [ -z "$PLATFORM" ] && [ "$HOST_ARCH" != "x86_64" ] && [ "$HOST_ARCH" != "amd64" ]; then
    echo "✗ 本机是 ${HOST_ARCH},未指定 --platform 会构建出 ${HOST_ARCH} 镜像,内网 x86_64 起不来。" >&2
    echo "  交付内网请显式指定:  PLATFORM=linux/amd64 $0 --base" >&2
    echo "  (交叉构建走 QEMU 模拟,pip 装 venv 会慢很多;更快的路子是直接在内网主节点上构建)" >&2
    echo "  确认只是本机自测、不交付,可以用:  PLATFORM=linux/$(uname -m) $0 --base  跳过本检查" >&2
    exit 1
  fi

  # ⚠ 不用 `git -C`:那是 git 1.8.5 才有的参数,Jenkins 主节点(RHEL 7.4)是
  #   1.8.3.1,直接报 `Unknown option: -C`(2026-08-26 stage 3 实测)。子 shell cd 全版本通吃。
  # tag 取 services/audit-ai 目录最后一次变动的提交 —— 内容不变则 tag 不变,判重幂等
  AUDIT_SHA="$( (cd "$REPO_ROOT" && git log -1 --format=%h -- services/audit-ai) )"
  [ -n "$AUDIT_SHA" ] || { echo "✗ services/audit-ai 无提交记录?" >&2; exit 1; }
  # tag = audit-ai 的 sha7(不带日期):确定性 tag,ci/00-ensure-base.sh 靠它判断
  # "这个 audit-ai 版本的底座造过没有"。同内容重造得到同 tag,幂等。
  TAG="${BASE_TAG:-$AUDIT_SHA}"
  IMAGE="${REGISTRY}/dfzq-pi-base:${TAG}"

  log "构建底座:$IMAGE  (services/audit-ai@${AUDIT_SHA}${PLATFORM:+, $PLATFORM})"
  run docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} \
      -f "$HERE/Dockerfile.base" \
      --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-}" \
      --build-arg "PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST:-}" \
      --build-arg "REGISTRY=${REGISTRY}" \
      --build-arg "RUNTIME_BASE_TAG=${RUNTIME_BASE_TAG}" \
      -t "$IMAGE" "$REPO_ROOT"

  [ "$PUSH" = 1 ] && run docker push "$IMAGE"
  log "完成:$IMAGE"
  log "⚠ 薄层的 BASE_TAG 要跟着改成:$TAG"
  exit 0
fi

# ---- 薄层(test / runtime)-------------------------------------------------
[ -n "${BASE_TAG:-}" ] || { echo "✗ 需要 BASE_TAG=<底座 tag>" >&2; exit 1; }
# 同上:不用 git -C,兼容主节点的 git 1.8.3.1
GIT_SHA="$( (cd "$REPO_ROOT" && git rev-parse --short=7 HEAD) )"

BUILD_ARGS=(
  --build-arg "BASE_TAG=${BASE_TAG}"
  --build-arg "REGISTRY=${REGISTRY}"
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-}"
)

if [ "$MODE" = "test" ]; then
  IMAGE="dfzq-pi-test:${GIT_SHA}"
  log "构建 test 阶段:$IMAGE"
  run docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} --target test \
      -f "$HERE/Dockerfile" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} -t "$IMAGE" "$REPO_ROOT"
  # 报告在镜像里的 /out,起一个临时容器拷出来
  log "取回 junit 报告 → $REPO_ROOT/.ci/"
  run mkdir -p "$REPO_ROOT/.ci"
  if [ "$DRY" = 0 ]; then
    cid="$(docker create "$IMAGE")"
    docker cp "$cid:/out/." "$REPO_ROOT/.ci/"
    docker rm -f "$cid" >/dev/null
  fi
  log "完成:$IMAGE"
  exit 0
fi

IMAGE="${REGISTRY}/dfzq-pi:${GIT_SHA}"
log "构建交付镜像:$IMAGE"
run docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} --target runtime \
    -f "$HERE/Dockerfile" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} -t "$IMAGE" "$REPO_ROOT"
[ "$PUSH" = 1 ] && run docker push "$IMAGE"
log "完成:$IMAGE"
