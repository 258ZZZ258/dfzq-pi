#!/usr/bin/env bash
# ops/status.sh —— 一屏看清整套栈现在是什么样。只读,不改任何状态。
#
#   ./status.sh                 打印状态
#   ./status.sh --dry-run       打印这个脚本会读哪些东西,然后退出(它本来也不写任何状态)
#
# 打印:五个容器的运行状态与健康状态、pi 用的是哪个镜像、/healthz 的响应体、
#       卷占用与宿主磁盘、以及一份"异常清单 + 该敲哪条命令"。
#
# 退出码:一切正常 = 0;发现任何异常 = 1(方便挂到定时任务里当探针用)。
#
# 🔴 容器状态一律 `docker inspect -f '{{.State.Health.Status}}'` 直接读结构化字段,
#    **不解析 `docker-compose ps` 的文本输出** —— unhealthy 在 compose 1.29.2 的
#    ps 输出里怎么呈现没有在那个版本上验证过,靠文本匹配等于赌。
#
# 🔴 "容器 Up 着、但 /healthz 不绿" 这一种故障,Docker **不会**自动重启容器
#    (restart: unless-stopped 只管容器退出,健康检查失败不触发重启),本轮也
#    没有看门狗自动处置。**这个脚本是发现它的唯一途径**,所以那一段报得很吵。
#
# 日志同时进 stdout 与 <deploy>/logs/status.sh-<时间戳>.log。
#
# ANCHORS: no-docker no-compose-cmd docker-daemon-down compose-file-missing
#          serve-not-healthy container-down
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
mkdir -p "$LOG_DIR"
# out —— 报告正文:原样进 stdout,同时落一份到日志(先脱敏)。
# 不带 [时间戳][INFO] 前缀,这是给人一眼扫的一屏,不是流水账。
out() { local line="$1"; printf '%s\n' "$line"; printf '%s\n' "$(redact_url_userinfo "$line")" >> "$LOG_FILE"; }
die() {
  local msg="$1" anchor="${2:-}"
  if [ -n "$anchor" ]; then msg="${msg}  → 见 ops/README.md 的「#${anchor}」一节"; fi
  out "ERR  ${msg}"
  exit 1
}

# ---- 参数 ------------------------------------------------------------------
DRY_RUN=0
usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数:$1(只认 --dry-run / --help)" ;;
  esac
  shift
done

# ---- 颜色:只在真的连着终端时上色,免得日志文件里全是转义序列 -----------------
# 每条异常同时带一个 ASCII 记号(‼ / ✔),不靠颜色也看得出来。
if [ -t 1 ]; then
  C_RED=$'\033[1;31m'; C_YEL=$'\033[1;33m'; C_GRN=$'\033[1;32m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=''; C_YEL=''; C_GRN=''; C_DIM=''; C_RST=''
fi

if [ "$DRY_RUN" = "1" ]; then
  out "[dry-run] status.sh 是只读脚本,任何时候都不会改变状态。它会执行:"
  out "[dry-run]   docker info                                       # 守护进程在不在"
  out "[dry-run]   <compose> -f ${COMPOSE_FILE} ps -q <服务>          # 拿容器 ID"
  out "[dry-run]   docker inspect -f '{{.State.Status}}' <容器>       # 运行状态"
  out "[dry-run]   docker inspect -f '{{.State.Health.Status}}' <容器> # 健康状态"
  out "[dry-run]   docker image inspect -f '{{.Created}}' <pi 镜像>   # 镜像构建时间"
  out "[dry-run]   curl http://127.0.0.1:<TASK_RUNTIME_PORT>/healthz  # 服务是否真的在干活"
  out "[dry-run]   docker system df / df -h                           # 卷占用与宿主磁盘"
  out "[dry-run] 预演结束。"
  exit 0
fi

# ---- 前置 ------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令" no-docker
docker info >/dev/null 2>&1 || die "docker info 失败 —— Docker 守护进程没起来,或当前用户没权限访问 /var/run/docker.sock" docker-daemon-down

COMPOSE_CMD=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  die "既没有 'docker compose' 子命令,也没有独立的 docker-compose 二进制" no-compose-cmd
fi
COMPOSE_VER="$(${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} version 2>/dev/null | head -n 1 || echo '版本未知')"

[ -f "$COMPOSE_FILE" ] || die "compose 文件不存在:${COMPOSE_FILE}" compose-file-missing

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  . "$ENV_FILE"
  set +a
  ENV_STATE="已载入"
else
  ENV_STATE="${C_RED}不存在${C_RST}"
fi

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

# ---- 汇总 ------------------------------------------------------------------
PROBLEMS=""            # 每行一条:"<醒目文本>|<该敲的命令>"
add_problem() { PROBLEMS="${PROBLEMS}$1"$'\n'; }

out ""
out "==================== dfzq-pi 五容器栈 · 状态 ===================="
out "时间        $(date '+%Y-%m-%d %H:%M:%S')"
out "compose     ${COMPOSE_CMD[*]+"${COMPOSE_CMD[*]}"}(${COMPOSE_VER})"
out "compose.yml ${COMPOSE_FILE}"
out ".env        ${ENV_FILE}(${ENV_STATE})"
out "项目名      ${COMPOSE_PROJECT_NAME:-<未设置,compose 会按目录名兜底>}"
out ""

# ---- 容器 ------------------------------------------------------------------
out "── 容器 ────────────────────────────────────────────────────────"
# 表头刻意用英文列名、状态值也刻意用英文:printf 的 %-8s 按**字节**补齐,中文一个字
# 三字节却只占两列宽,混排必然错位。这几个词都是 docker 自己的原词,对照下面
# 「怎么读这张表」那几行看即可。
out "  SERVICE  STATE        HEALTH           CONTAINER"
for svc in pg etcd minio milvus pi; do
  cid="$(container_id "$svc")"
  if [ -z "$cid" ]; then
    rstat="absent"; hstat="-"; cname="-"
  else
    rstat="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
    # 🔴 直接读 .State.Health.Status。没有 healthcheck 的容器这个字段是 nil,
    #    模板里必须先 {{if .State.Health}} 挡一下,否则 inspect 会报模板错误。
    hstat="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$cid" 2>/dev/null || echo unknown)"
    cname="$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##' || echo unknown)"
  fi

  mark="  "; color=""
  if [ "$rstat" != "running" ]; then
    mark="${C_RED}‼ ${C_RST}"; color="$C_RED"
    if [ "$svc" = "pi" ]; then
      add_problem "${C_RED}‼ pi 容器不在运行(${rstat})${C_RST} —— 敲:./restart.sh          【README #container-down】"
    else
      add_problem "${C_RED}‼ ${svc} 容器不在运行(${rstat})${C_RST} —— 敲:./restart.sh --all   【README #container-down】"
    fi
  elif [ "$hstat" != "healthy" ] && [ "$hstat" != "no-healthcheck" ]; then
    mark="${C_RED}‼ ${C_RST}"; color="$C_RED"
    if [ "$svc" = "pi" ]; then
      add_problem "${C_RED}‼ pi 容器 running 但健康检查是 ${hstat}${C_RST} —— 敲:./restart.sh   【README #serve-not-healthy】"
    else
      add_problem "${C_RED}‼ ${svc} 容器 running 但健康检查是 ${hstat}${C_RST} —— 敲:./restart.sh --all   【README #container-down】"
    fi
  fi
  out "$(printf '%s%s%-8s %-12s %-16s %s%s' "$mark" "$color" "$svc" "$rstat" "$hstat" "$cname" "$C_RST")"
done
out "  怎么读这张表:STATE=running 且 HEALTH=healthy 才算正常;"
out "               STATE 里 exited/created/restarting 都是没跑起来,absent 是容器压根不存在;"
out "               HEALTH 里 starting 是还在启动(等一会再看),unhealthy 是探针连续失败。"
out ""

# ---- 镜像 ------------------------------------------------------------------
out "── 镜像 ────────────────────────────────────────────────────────"
PI_CID="$(container_id pi)"
if [ -z "$PI_CID" ]; then
  out "  pi 容器不存在,看不到它在用哪个镜像。先跑 ./deploy.sh"
else
  PI_IMG_REF="$(docker inspect -f '{{.Config.Image}}' "$PI_CID" 2>/dev/null || echo 未知)"
  PI_IMG_ID="$(docker inspect -f '{{.Image}}' "$PI_CID" 2>/dev/null || echo '')"
  PI_IMG_CREATED="$(docker image inspect -f '{{.Created}}' "$PI_IMG_ID" 2>/dev/null || echo 未知)"
  out "  正在跑    ${PI_IMG_REF}"
  out "  镜像 ID   ${PI_IMG_ID}"
  out "  构建时间  ${PI_IMG_CREATED}"
  if [ -n "${PI_IMAGE:-}" ] && [ "${PI_IMAGE}" != "${PI_IMG_REF}" ]; then
    out "  ${C_YEL}⚠ .env 里写的是 ${PI_IMAGE},和正在跑的这个不一样${C_RST}"
    add_problem "${C_YEL}⚠ .env 的 PI_IMAGE 与容器实际在跑的镜像不一致${C_RST} —— 想让 .env 生效敲:./deploy.sh"
  fi
fi
out ""

# ---- 服务 ------------------------------------------------------------------
out "── 服务 ────────────────────────────────────────────────────────"
HEALTH_PORT="${TASK_RUNTIME_PORT:-18080}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/healthz"
out "  GET ${HEALTH_URL}(超时 5s)"
# ⚠ 这里用的是 .env 的 TASK_RUNTIME_PORT,它是**宿主**发布端口;容器内 serve 一律
#    监听 18080(由 compose.yml 的 pi.environment 钉死,优先级高于 env_file)。
#    两者不同是正常的,不要以为对不上。
# ⚠ curl 的 stderr 要单独接住,**不能** 2>&1 混进响应体:连不上的时候 curl 会往
#   stderr 写一行 "Failed to connect...",混进来之后"响应体非空"这条判断就成立了,
#   于是"连都没连上"会被报成"有响应但不是 ok:true" —— 两种故障指向完全不同的排查路径。
_CURL_ERR_FILE="$(mktemp)"
if HEALTHZ_BODY="$(curl -sS --connect-timeout 2 --max-time 5 "$HEALTH_URL" 2>"$_CURL_ERR_FILE")"; then
  CURL_OK=1
else
  CURL_OK=0
fi
CURL_ERR="$(cat "$_CURL_ERR_FILE" 2>/dev/null || true)"
rm -f "$_CURL_ERR_FILE"
if [ "$CURL_OK" != "1" ] || [ -z "$HEALTHZ_BODY" ]; then
  HEALTHZ_VERDICT="no-response"
else
  # 🔴 用 python3 解析 JSON 判 ok 是不是布尔 true,**不用 grep 匹配 '"ok":true' 字符串**。
  #    响应体里的 errorMessage 完全可能原样带着同一串文本,grep 会把"报错"读成"健康"。
  if printf '%s' "$HEALTHZ_BODY" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
sys.exit(0 if d.get("ok") is True else 1)
' >/dev/null 2>&1; then
    HEALTHZ_VERDICT="ok"
  else
    HEALTHZ_VERDICT="not-ok"
  fi
fi
case "$HEALTHZ_VERDICT" in
  ok)
    out "  ${C_GRN}✔ ok:true${C_RST}"
    out "  响应体:${HEALTHZ_BODY}"
    ;;
  not-ok)
    out "  ${C_RED}‼ 有响应,但不是 ok:true${C_RST}"
    out "  响应体:${HEALTHZ_BODY}"
    ;;
  no-response)
    out "  ${C_RED}‼ 探不到(连不上或超时)${C_RST}"
    if [ -n "$CURL_ERR" ]; then out "  curl 说:${CURL_ERR}"; fi
    ;;
esac

# 🔴 这一段就是 D-9 说的"本轮不自动处置"的那种故障的唯一发现途径:
#    容器 Up 着、Docker 也不会重启它,但服务其实是死的。报得吵一点。
PI_RSTAT="-"
PI_NAME="$PI_CID"
if [ -n "$PI_CID" ]; then
  PI_RSTAT="$(docker inspect -f '{{.State.Status}}' "$PI_CID" 2>/dev/null || echo unknown)"
  PI_NAME="$(docker inspect -f '{{.Name}}' "$PI_CID" 2>/dev/null | sed 's#^/##' || echo "$PI_CID")"
fi
if [ "$PI_RSTAT" = "running" ] && [ "$HEALTHZ_VERDICT" != "ok" ]; then
  out ""
  out "  ${C_RED}==============================================================${C_RST}"
  out "  ${C_RED}‼‼ 容器 running,但 /healthz 不绿 —— 服务实际上是坏的。      ${C_RST}"
  out "  ${C_RED}   Docker 不会自己修这种情况(restart 策略只管容器退出,     ${C_RST}"
  out "  ${C_RED}   健康检查失败不触发重启),也没有看门狗会替你处理。        ${C_RST}"
  out "  ${C_RED}   要人工介入:  ./restart.sh                                ${C_RST}"
  out "  ${C_RED}   还不行就看日志: docker logs --tail 100 ${PI_NAME}${C_RST}"
  out "  ${C_RED}   见 ops/README.md 的「#serve-not-healthy」一节             ${C_RST}"
  out "  ${C_RED}==============================================================${C_RST}"
  add_problem "${C_RED}‼‼ pi 容器 running 但 /healthz 不绿(服务是坏的,不会自愈)${C_RST} —— 敲:./restart.sh   【README #serve-not-healthy】"
fi
out ""

# ---- 存储 ------------------------------------------------------------------
out "── 存储 ────────────────────────────────────────────────────────"
out "  docker system df:"
while IFS= read -r line; do out "    ${line}"; done <<EOF
$(docker system df 2>&1 || echo "(读不到)")
EOF
if [ -n "$PI_CID" ]; then
  PROJ="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PI_CID" 2>/dev/null || echo '')"
else
  PROJ="${COMPOSE_PROJECT_NAME:-}"
fi
if [ -n "$PROJ" ]; then
  out "  本栈的卷(项目 ${PROJ},🔴 这些卷里是 PG 语料和 Milvus collection,删了要重灌 48.5 小时):"
  VOL_LIST="$(docker volume ls --filter "label=com.docker.compose.project=${PROJ}" --format '{{.Name}}' 2>/dev/null || true)"
  if [ -z "$VOL_LIST" ]; then
    out "    (一个都没有 —— 这套栈还没在这台机器上起过,或者项目名和之前不一样)"
  else
    while IFS= read -r line; do [ -n "$line" ] && out "    ${line}"; done <<EOF
${VOL_LIST}
EOF
  fi
fi
out "  宿主磁盘:"
# ⚠ 别写成 `df -h / /var/lib/docker || df -h /`:第一条即使因为某个路径不存在而
#   返回非零,它也已经把存在的那个挂载点打印出来了,后面的兜底会再打印一遍。
DF_ARGS="/"
if [ -d /var/lib/docker ]; then DF_ARGS="/ /var/lib/docker"; fi
# shellcheck disable=SC2086
while IFS= read -r line; do out "    ${line}"; done <<EOF
$(df -h $DF_ARGS 2>/dev/null || echo "(读不到)")
EOF
# 磁盘水位:规格 §0.2 记着生产机只有 70G,低于建议值,所以这里主动盯一眼。
DISK_USE="$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}' || echo '')"
if [ -n "$DISK_USE" ] && [ "$DISK_USE" -ge 85 ] 2>/dev/null; then
  out "  ${C_RED}‼ 根分区已用 ${DISK_USE}%${C_RST}"
  add_problem "${C_RED}‼ 宿主根分区已用 ${DISK_USE}%(生产机总共只有 70G)${C_RST} —— 先清 docker 构建缓存:docker builder prune;🔴 千万不要 docker system prune -a"
fi
out ""

# ---- 结论 ------------------------------------------------------------------
out "── 结论 ────────────────────────────────────────────────────────"
if [ -z "$PROBLEMS" ]; then
  out "  ${C_GRN}✔ 一切正常:五个容器都 running 且 healthy,/healthz 返回 ok:true。${C_RST}"
  out ""
  out "  ${C_DIM}(完整记录已存到 ${LOG_FILE})${C_RST}"
  exit 0
fi
out "  ${C_RED}发现下面这些问题,按顺序处理:${C_RST}"
printf '%s' "$PROBLEMS" | while IFS= read -r p; do
  [ -n "$p" ] && out "    ${p}"
done
out ""
out "  ${C_DIM}(完整记录已存到 ${LOG_FILE})${C_RST}"
# 🔴 退出码非 0,方便别人拿它当探针挂到定时任务里。
exit 1
