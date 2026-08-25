#!/usr/bin/env bash
# ops/restart.sh —— 重启容器。缺省只动 pi,不碰数据层。
#
#   ./restart.sh                只重启 pi(pg / etcd / minio / milvus 原样不动)
#   ./restart.sh --all          连数据层四个一起重启
#   ./restart.sh --dry-run      只打印将要执行的命令,不碰任何容器
#
# 重启完轮询 /healthz(超时 120s)。不绿就停下、打印 pi 最近 50 行日志,
# 并指到 ops/README.md 的对应小节。
#
# 🔴 用的是 `compose restart`,只重启进程,不重建容器、不删卷、不改镜像。
#    要换镜像版本用 ./deploy.sh --tag <sha>,不是这个脚本。
#
# 日志同时进 stdout 与 <deploy>/logs/restart.sh-<时间戳>.log。
#
# ANCHORS: no-docker no-compose-cmd docker-daemon-down compose-file-missing
#          env-missing env-perm pg-not-healthy etcd-not-healthy
#          minio-not-healthy milvus-not-healthy serve-not-healthy
set -euo pipefail

# ---- 位置:脚本自己推出 deploy 目录,不依赖调用者的 cwd ----------------------
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${OPS_DIR}/.." && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env"
LOG_DIR="${DEPLOY_DIR}/logs"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
LOG_FILE="${LOG_DIR}/${SCRIPT_NAME}-$(date +%Y%m%d-%H%M%S).log"

# ---- 日志 ------------------------------------------------------------------
redact_url_userinfo() {
  printf '%s' "$1" | sed -E 's#([a-zA-Z][a-zA-Z0-9+.-]*://[^/@[:space:]]*):[^/@[:space:]]*@#\1:***@#g'
}
_log_line() {
  local level="$1" msg="$2"
  mkdir -p "$LOG_DIR"
  msg="$(redact_url_userinfo "$msg")"
  printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$msg" | tee -a "$LOG_FILE"
}
log_info() { _log_line INFO "$1"; }
log_warn() { _log_line WARN "$1"; }
log_err()  { _log_line ERR  "$1"; }
die() {
  local msg="$1" anchor="${2:-}"
  if [ -n "$anchor" ]; then
    msg="${msg}  → 见 ops/README.md 的「#${anchor}」一节"
  fi
  log_err "$msg"
  exit 1
}

# ---- 参数 ------------------------------------------------------------------
DRY_RUN=0
ALL=0
usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数:$1(只认 --all / --dry-run / --help)" ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" = "1" ]; then
    log_info "[dry-run] $*"
  else
    log_info "+ $*"
    "$@"
  fi
}
PRECHECK_FAILED=0
check_fail() {
  local msg="$1" anchor="${2:-}"
  if [ "$DRY_RUN" = "1" ]; then
    PRECHECK_FAILED=$((PRECHECK_FAILED + 1))
    if [ -n "$anchor" ]; then msg="${msg}  → 见 ops/README.md 的「#${anchor}」一节"; fi
    log_warn "[dry-run] 前置检查未通过(真实执行会在这里中止):${msg}"
    return 0
  fi
  die "$msg" "$anchor"
}

if [ "$DRY_RUN" = "1" ]; then
  log_info "==== restart.sh 开始(--dry-run 预演,不重启任何容器)===="
else
  log_info "==== restart.sh 开始 ===="
fi
if [ "$ALL" = "1" ]; then
  log_info "范围:数据层 pg / etcd / minio / milvus + pi(--all)"
else
  log_info "范围:只有 pi(数据层不动;要连数据层一起重启加 --all)"
fi

# ---- 前置 ------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || check_fail "找不到 docker 命令" no-docker

COMPOSE_CMD=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  check_fail "既没有 'docker compose' 子命令,也没有独立的 docker-compose 二进制" no-compose-cmd
  COMPOSE_CMD=(docker-compose)
fi

if ! docker info >/dev/null 2>&1; then
  check_fail "docker info 失败 —— Docker 守护进程没起来,或当前用户没有访问 /var/run/docker.sock 的权限" docker-daemon-down
fi

[ -f "$COMPOSE_FILE" ] || check_fail "compose 文件不存在:${COMPOSE_FILE}" compose-file-missing

_stat_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || true; }
if [ ! -f "$ENV_FILE" ]; then
  check_fail "${ENV_FILE} 不存在 —— 先 cp .env.example .env 并填好,再 chmod 600 .env" env-missing
else
  ENV_MODE="$(_stat_mode "$ENV_FILE")"
  if [ "$ENV_MODE" != "600" ]; then
    check_fail "${ENV_FILE} 权限须为 600(当前 ${ENV_MODE:-未知}),执行:chmod 600 ${ENV_FILE}" env-perm
  fi
  set -a
  # shellcheck disable=SC1090,SC1091
  . "$ENV_FILE"
  set +a
fi

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then COMPOSE_ARGS+=(--env-file "$ENV_FILE"); fi
compose() {
  ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"
}
compose_run() {
  run ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"
}

# 🔴 直接 docker inspect 读结构化字段,不解析 compose ps 的文本输出。
container_id() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null | head -n 1 || true)"
  if [ -z "$cid" ]; then
    cid="$(compose ps -a -q "$1" 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s' "$cid"
}
health_status() {
  local cid
  cid="$(container_id "$1")"
  if [ -z "$cid" ]; then printf 'absent'; return 0; fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
    "$cid" 2>/dev/null || printf 'absent'
}

_die_not_healthy() {
  local svc="$1" secs="$2" cid
  cid="$(container_id "$svc")"
  log_err "${svc} 重启后 ${secs}s 内没有变成 healthy,下面是它最近 50 行日志:"
  if [ -n "$cid" ]; then docker logs --tail 50 "$cid" 2>&1 | tee -a "$LOG_FILE" || true; fi
  case "$svc" in
    pg)     die "pg 重启后超时未健康" pg-not-healthy ;;
    etcd)   die "etcd 重启后超时未健康" etcd-not-healthy ;;
    minio)  die "minio 重启后超时未健康" minio-not-healthy ;;
    milvus) die "milvus 重启后超时未健康" milvus-not-healthy ;;
    *)      die "${svc} 重启后超时未健康" ;;
  esac
}
wait_healthy() {
  local svc="$1" timeout="$2" waited=0 interval="${STACK_POLL_INTERVAL:-3}"
  log_info "等待 ${svc} healthy(超时 ${timeout}s,当前 $(health_status "$svc"))…"
  while [ "$(health_status "$svc")" != "healthy" ]; do
    if [ "$waited" -ge "$timeout" ]; then
      _die_not_healthy "$svc" "$timeout"
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
  log_info "${svc} healthy(等了约 ${waited}s)"
}

HEALTH_PORT="${TASK_RUNTIME_PORT:-18080}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/healthz"
# 🔴 用 python3 解析 JSON 判 ok,不用 grep 匹配 '"ok":true' 字符串 —— 那种匹配
#    会被塞进 errorMessage 里的同样文本骗到,把"报错"读成"健康"。
healthz_ok() {
  local body
  body="$(curl -sS --connect-timeout 2 --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  [ -n "$body" ] || return 1
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("ok") is True else 1)
' 2>/dev/null || return 1
  printf '%s' "$body"
}

# ---- 重启 ------------------------------------------------------------------
if [ "$ALL" = "1" ]; then
  log_info "---- 重启数据层 ----"
  compose_run restart pg etcd minio milvus
  if [ "$DRY_RUN" = "1" ]; then
    log_info "[dry-run] 然后逐个轮询到 healthy:etcd / minio / pg 各 ${STACK_HEALTH_TIMEOUT:-300}s,milvus ${MILVUS_HEALTH_TIMEOUT:-300}s"
  else
    wait_healthy etcd   "${STACK_HEALTH_TIMEOUT:-300}"
    wait_healthy minio  "${STACK_HEALTH_TIMEOUT:-300}"
    wait_healthy pg     "${STACK_HEALTH_TIMEOUT:-300}"
    wait_healthy milvus "${MILVUS_HEALTH_TIMEOUT:-300}"
    log_info "数据层四个容器全部 healthy"
  fi
fi

log_info "---- 重启 pi ----"
compose_run restart pi

SERVE_TIMEOUT="${SERVE_HEALTH_TIMEOUT:-120}"
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 然后轮询 ${HEALTH_URL} 最多 ${SERVE_TIMEOUT}s;不绿则打印 docker logs --tail 50 并以 serve-not-healthy 中止"
  log_info "[dry-run] 预演结束 —— 没有重启过任何容器"
  exit 0
fi

log_info "等待 ${HEALTH_URL} 返回 ok:true(超时 ${SERVE_TIMEOUT}s)…"
waited=0
while true; do
  if BODY="$(healthz_ok)"; then
    log_info "pi healthy(等了约 ${waited}s):${BODY}"
    break
  fi
  if [ "$waited" -ge "$SERVE_TIMEOUT" ]; then
    PI_CID="$(container_id pi)"
    log_err "pi 在 ${SERVE_TIMEOUT}s 内没有返回 ok:true。"
    log_err "pi 容器状态:$(health_status pi);最近 50 行日志:"
    if [ -n "$PI_CID" ]; then
      docker logs --tail 50 "$PI_CID" 2>&1 | tee -a "$LOG_FILE" || true
    else
      log_err "(找不到 pi 容器 —— 它可能压根没起来,先跑 ./deploy.sh)"
    fi
    log_err "接下来怎么办:先看上面日志的最后几行;若是连不上 pg / milvus,跑 ./restart.sh --all;"
    log_err "若是缺环境变量或凭证不对,改 ../.env 后跑 ./deploy.sh。"
    die "pi 重启后 /healthz 不绿" serve-not-healthy
  fi
  sleep 3
  waited=$((waited + 3))
done

log_info "==== restart.sh 完成 —— 日志:${LOG_FILE} ===="
