#!/usr/bin/env bash
# ops/stop.sh —— 计划内停机。停掉五个容器,**卷一个不动**。
#
#   ./stop.sh                   停掉 pg / etcd / minio / milvus / pi
#   ./stop.sh --dry-run         只打印将要执行的命令,什么都不停
#
# 恢复:./deploy.sh(它会把容器重新起起来,数据原样还在)。
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │ 🔴🔴🔴 这个脚本只用 `docker-compose stop`,**永远不会**用 down -v。       │
# │                                                                          │
# │  `docker-compose down -v` 的 -v 是 "--volumes":它会把这套栈的数据卷      │
# │  **全部删除**。后果是                                                    │
# │      · PG 里的全部语料、任务历史、字典表 —— 没了                         │
# │      · Milvus 的 audit_corpus collection 与全部向量 —— 没了              │
# │      · 灌库要从头重来,现场实测一轮是 **48.5 小时**                       │
# │  删掉的卷没有回收站、没有撤销、docker 也不会问你第二遍。                  │
# │                                                                          │
# │  `stop` 只是把容器里的进程停掉,卷、镜像、网络都留着,随时能起回来。      │
# │  想省磁盘、想"清理干净"、想重装 —— 都不要用 down -v,先问开发。          │
# └──────────────────────────────────────────────────────────────────────────┘
#
# 日志同时进 stdout 与 <deploy>/logs/stop.sh-<时间戳>.log。
#
# ANCHORS: no-docker no-compose-cmd docker-daemon-down compose-file-missing
set -euo pipefail

# ---- 位置:脚本自己推出 deploy 目录,不依赖调用者的 cwd ----------------------
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${OPS_DIR}/.." && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env"
LOG_DIR="${DEPLOY_DIR}/logs"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
LOG_FILE="${LOG_DIR}/${SCRIPT_NAME}-$(date +%Y%m%d-%H%M%S).log"

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
  if [ -n "$anchor" ]; then msg="${msg}  → 见 ops/README.md 的「#${anchor}」一节"; fi
  log_err "$msg"
  exit 1
}

# ---- 参数 ------------------------------------------------------------------
DRY_RUN=0
usage() { sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数:$1(这个脚本只认 --dry-run / --help;它刻意不接受任何能删数据的开关)" ;;
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
  log_info "==== stop.sh 开始(--dry-run 预演,不停任何容器)===="
else
  log_info "==== stop.sh 开始 ===="
fi
log_info "只停容器,不删卷 —— 数据原样保留,恢复用 ./deploy.sh"

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

COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then COMPOSE_ARGS+=(--env-file "$ENV_FILE"); fi
compose() {
  ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"
}

container_id() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null | head -n 1 || true)"
  if [ -z "$cid" ]; then
    cid="$(compose ps -a -q "$1" 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s' "$cid"
}
run_status() {
  local cid
  cid="$(container_id "$1")"
  if [ -z "$cid" ]; then printf 'absent'; return 0; fi
  docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || printf 'unknown'
}

# ---- 停 --------------------------------------------------------------------
# 顺序:先停 pi(它连着 pg / milvus,先摘掉用的一方),再停数据层。
# compose stop 本身对已经停掉的服务是个空操作,重复跑没有副作用。
log_info "---- 停 pi ----"
run ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} stop pi
log_info "---- 停数据层 milvus / minio / etcd / pg ----"
run ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} stop milvus minio etcd pg

if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 停完会逐个打印容器状态确认;卷不会被碰"
  log_info "[dry-run] 预演结束 —— 没有停过任何容器,也没有动过任何卷"
  exit 0
fi

log_info "---- 停完的状态 ----"
for svc in pg etcd minio milvus pi; do
  log_info "  ${svc}: $(run_status "$svc")"
done
log_info "卷没有被碰。数据都在,恢复敲:./deploy.sh"
log_info "==== stop.sh 完成 —— 日志:${LOG_FILE} ===="
