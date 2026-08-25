#!/usr/bin/env bash
# ops/deploy.sh —— 首次部署 / 升版本 / 回滚。跑完五个容器全部 healthy、/healthz 返 ok。
#
#   ./deploy.sh                 用 .env 里的 PI_IMAGE 部署
#   ./deploy.sh --tag <sha>     指定 pi 镜像版本(回滚 = 指向旧 tag 重跑一遍)
#   ./deploy.sh --dry-run       只打印将要执行的命令,不碰任何容器和卷
#
# 六步:前置检查 → pull → 起数据层等 healthy → 建库 → 起 pi 等 /healthz → 摘要。
#
# 🔴 幂等靠**真实状态**判断,不靠标记文件:容器已 healthy 就不必重建,建库三段
#    各自在 init.sh 内部按"库里到底有没有"短路。这个脚本重跑任意多次都安全,
#    不会重置数据、不会重新灌库。
#
# 🔴 绝不删卷。这个脚本里没有任何一条会丢数据的命令。
#
# 日志同时进 stdout 与 <deploy>/logs/deploy.sh-<时间戳>.log。
#
# ANCHORS: no-docker no-compose-cmd docker-daemon-down registry-unreachable
#          compose-file-missing env-missing env-perm env-incomplete pull-failed
#          pg-not-healthy etcd-not-healthy minio-not-healthy milvus-not-healthy
#          init-failed serve-not-healthy
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
# 写进日志的每一行都先过一道 URL 口令脱敏:PIPELINE_DB_DSN 这类"值里内嵌凭证"的
# 变量会被打印出来(比如 compose 报错回显),不脱敏就等于把库口令落盘。
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

# die MSG [ANCHOR] —— 打印后 exit 1;带锚点时指向 ops/README.md 的对应小节
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
PI_TAG=""
usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tag)
      [ $# -ge 2 ] || die "--tag 后面要跟镜像 tag(pi 的 git sha 前 7 位)"
      PI_TAG="$2"; shift ;;
    --tag=*) PI_TAG="${1#--tag=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数:$1(只认 --tag <sha> / --dry-run / --help)" ;;
  esac
  shift
done
if [ -n "$PI_TAG" ]; then
  case "$PI_TAG" in
    *[!0-9A-Za-z._-]*) die "--tag 的值含非法字符:${PI_TAG}(只允许字母数字与 . _ -)" ;;
  esac
fi

# run CMD... —— dry-run 只打印,真实执行时先打印再跑
run() {
  if [ "$DRY_RUN" = "1" ]; then
    log_info "[dry-run] $*"
  else
    log_info "+ $*"
    "$@"
  fi
}

# check_fail MSG [ANCHOR] —— 前置检查失败:真实执行时中止;dry-run 时降级成 WARN
# 继续往下走。这样在没有 registry / 没有 .env 的机器上也能预演一遍完整流程。
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
  log_info "==== deploy.sh 开始(--dry-run 预演,不起容器、不拉镜像、不动卷)===="
else
  log_info "==== deploy.sh 开始 ===="
fi
log_info "deploy 目录:${DEPLOY_DIR}"

# ============================================================================
# 第 1 步 · 前置检查
# ============================================================================
log_info "---- 1/6 前置检查 ----"

command -v docker >/dev/null 2>&1 \
  || check_fail "找不到 docker 命令" no-docker

# compose 两种形态:目标机是 docker-compose 1.29.2 独立二进制(Docker 19.03 没有
# `docker compose` 子命令),开发机多半是 `docker compose` 插件。探测一次,后面统一
# 走 COMPOSE_CMD,不在多处分别硬编码某一种形态。
COMPOSE_CMD=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  check_fail "既没有 'docker compose' 子命令,也没有独立的 docker-compose 二进制" no-compose-cmd
  COMPOSE_CMD=(docker-compose)
fi
COMPOSE_VER="$(${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} version 2>/dev/null | head -n 1 || echo '版本未知')"
log_info "compose 命令:${COMPOSE_CMD[*]+"${COMPOSE_CMD[*]}"}(${COMPOSE_VER})"

if ! docker info >/dev/null 2>&1; then
  check_fail "docker info 失败 —— Docker 守护进程没起来,或当前用户没有访问 /var/run/docker.sock 的权限" docker-daemon-down
fi

[ -f "$COMPOSE_FILE" ] || check_fail "compose 文件不存在:${COMPOSE_FILE}" compose-file-missing

# ---- .env:存在 / 权限 0600 / 必填项非空 ----
# _stat_mode:线上是 Linux(GNU stat -c),开发机 macOS 是 BSD stat(-f %Lp)。
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
  log_info ".env 已载入:${ENV_FILE}"
fi

# 必填项:serve.ts 的 requireEnv 六项 + LLM_API_KEY + PG_PASSWORD + PI_IMAGE。
# 🔴 不含 TASK_RUNTIME_DB_PATH —— sqlite 存储已从 task-runtime 移除,那个变量是死的,
#    真正要的是 PIPELINE_DB_DSN。
MISSING=""
for _n in TASK_RUNTIME_INTERNAL_TOKEN TASK_RUNTIME_PORT PIPELINE_DB_DSN \
          TASK_RUNTIME_SPECS_DIR TASK_RUNTIME_PROFILE TASK_RUNTIME_WORK_ROOT \
          LLM_API_KEY PG_PASSWORD PI_IMAGE; do
  eval "_v=\${${_n}:-}"
  if [ -z "$_v" ]; then MISSING="${MISSING} ${_n}"; fi
done
if [ -n "$MISSING" ]; then
  check_fail "${ENV_FILE} 里这些必填项是空的:${MISSING# } —— 每一项在 .env.example 里都有说明" env-incomplete
fi

# ⚠ .env 里的 TASK_RUNTIME_PORT 是**宿主**发布端口(承 predeploy 的既有口径)。
#   容器内 serve 的监听端口由 compose.yml 的 pi.environment 钉死在 18080
#   (environment: 的优先级高于 env_file),不受这个值影响。
#   所以下面轮询 /healthz 用的是 127.0.0.1:${TASK_RUNTIME_PORT},这是对的。

# ---- pi 镜像:--tag 换 tag 段 ----
# 只有当最后一个 ':' 出现在最后一个 '/' 之后,它才是 tag 分隔符;
# 'host:5000/repo' 这种带端口的 registry 不能被误当成 tag。
retag_image() {
  local ref="$1" tag="$2" repo last
  ref="${ref%%@*}"                 # 有 @sha256:... 的话先剥掉
  last="${ref##*/}"
  if [ "$last" != "${last%:*}" ]; then repo="${ref%:*}"; else repo="$ref"; fi
  printf '%s:%s' "$repo" "$tag"
}
if [ -n "$PI_TAG" ]; then
  if [ -z "${PI_IMAGE:-}" ]; then
    check_fail "用了 --tag 但 .env 里没有 PI_IMAGE —— 换 tag 需要知道 registry 和仓库名" env-incomplete
  else
    PI_IMAGE="$(retag_image "$PI_IMAGE" "$PI_TAG")"
    export PI_IMAGE
    log_info "按 --tag 覆盖 pi 镜像:${PI_IMAGE}"
  fi
fi
log_info "本次要部署的 pi 镜像:${PI_IMAGE:-<未设置>}"

# ---- registry:登录状态 + 可达性 ----
# ⚠ 规格写的是"docker info 能连 JFrog",但 docker info **不报告**到某个私有 registry
#   的连通性或登录状态(它只报 Docker Hub 那一条)。这里换成两条真能测出来的:
#     a) ~/.docker/config.json 的 auths 里有没有这个 host  → 没有就是没 docker login
#     b) curl https://<host>/v2/ 有没有 HTTP 响应          → 没有就是网络/证书不通
#   两条都归到同一个锚点 registry-unreachable。
# registry_host_of REF —— 取出镜像引用里的 registry 主机名,取不到就打印空。
# docker 的判定规则:第一段是 registry,当且仅当引用里有 '/' **并且**第一段带 '.'、
# 带 ':' 或就是 localhost。少了"有 '/'"这一条,`dfzq-pi:1` 这种裸镜像名会因为带冒号
# 被误当成主机名 `dfzq-pi:1`。
registry_host_of() {
  local ref="$1" first
  case "$ref" in
    */*) ;;
    *) printf ''; return 0 ;;
  esac
  first="${ref%%/*}"
  case "$first" in
    localhost|*.*|*:*) printf '%s' "$first" ;;
    *) printf '' ;;
  esac
}
REGISTRY_HOST="$(registry_host_of "${PI_IMAGE:-}")"
if [ -z "$REGISTRY_HOST" ]; then
  log_warn "PI_IMAGE 里看不出 registry 主机名(${PI_IMAGE:-<未设置>}),跳过 registry 检查"
else
  DOCKER_CFG="${DOCKER_CONFIG:-${HOME}/.docker}/config.json"
  REG_LOGGED_IN=0
  if [ -f "$DOCKER_CFG" ]; then
    if python3 - "$DOCKER_CFG" "$REGISTRY_HOST" >/dev/null 2>&1 <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
host = sys.argv[2]
keys = set(cfg.get("auths") or {}) | set(cfg.get("credHelpers") or {})
ok = any(host == k or k.endswith("://" + host) or k.startswith(host + "/") for k in keys)
sys.exit(0 if ok else 1)
PY
    then
      REG_LOGGED_IN=1
    fi
  fi
  # 🔴 先探可达性再判登录 —— 顺序很重要。
  #    "没登录" 只有在 registry **确实要求认证** 时才是故障:匿名可拉的 registry
  #    (以及本地起的测试 registry)本来就没有 auths 条目,硬判失败是误报。
  #    /v2/ 返 200 = 匿名就能访问 → 只 WARN;返 401/403 = 要认证而没登录 → 真失败。
  #    (本轮实测:对着一个无鉴权的本地 registry 跑,老逻辑在第 1 步就把整条命令打红。)
  REG_ANON_OK=0
  if command -v curl >/dev/null 2>&1; then
    # /v2/ 未认证时返 401,那也算"通"—— 只要拿到任何 HTTP 状态码就说明网络与证书没问题。
    # ⚠ 这里刻意把 curl 的**退出码**和它打印的 http_code 分开看:连不上时 curl 自己
    #   会往 stdout 写一个 "000",要是再用 `|| echo 000` 兜底,命令替换会把两段拼成
    #   "000000",跟 "000" 比就永远不相等 —— 连不上会被误报成"可达"。
    if RCODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
                "https://${REGISTRY_HOST}/v2/" 2>/dev/null)"; then
      CURL_OK=1
    else
      CURL_OK=0
    fi
    # 内网 registry 也可能是纯 http(19.03 + insecure-registries),https 探不到时回落一次
    if [ "$CURL_OK" != "1" ] || [ -z "$RCODE" ] || [ "$RCODE" = "000" ]; then
      if RCODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
                  "http://${REGISTRY_HOST}/v2/" 2>/dev/null)"; then
        CURL_OK=1
      else
        CURL_OK=0
      fi
    fi
    if [ "$CURL_OK" = "1" ] && [ -n "$RCODE" ] && [ "$RCODE" != "000" ]; then
      log_info "registry 可达:${REGISTRY_HOST}/v2/ → HTTP ${RCODE}"
      [ "$RCODE" = "200" ] && REG_ANON_OK=1
    else
      check_fail "连不上 registry ${REGISTRY_HOST}/v2/(网络不通,或 Docker 19.03 需要在 /etc/docker/daemon.json 配 insecure-registries / 装内网 CA)" registry-unreachable
    fi
  else
    log_warn "本机没有 curl,跳过 registry 可达性探测"
  fi

  if [ "$REG_LOGGED_IN" = "1" ]; then
    log_info "registry 登录状态:${REGISTRY_HOST} 已在 ${DOCKER_CFG} 中登记"
  elif [ "$REG_ANON_OK" = "1" ]; then
    log_warn "没有登录 ${REGISTRY_HOST},但它 /v2/ 返 200(匿名可访问)—— 继续。若之后 pull 报 401,执行:docker login ${REGISTRY_HOST}"
  else
    check_fail "没有登录 registry ${REGISTRY_HOST}(${DOCKER_CFG} 的 auths 里查不到),且它要求认证 —— 执行:docker login ${REGISTRY_HOST}" registry-unreachable
  fi
fi

if [ "$DRY_RUN" = "1" ] && [ "$PRECHECK_FAILED" -gt 0 ]; then
  log_warn "[dry-run] 共 ${PRECHECK_FAILED} 项前置检查没过 —— 真实执行会在第 1 步中止;下面只是把后续步骤的命令打印出来"
fi

# ---- compose 调用统一入口 ----
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
# 🔴 显式 --env-file:compose 找 .env 的规则在 v1/v2、不同小版本之间不一致(有的看
#    当前工作目录,有的看 compose 文件所在目录)。显式传绝对路径,消掉这个二义性。
if [ -f "$ENV_FILE" ]; then COMPOSE_ARGS+=(--env-file "$ENV_FILE"); fi
compose() {
  ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"
}
compose_run() {
  run ${COMPOSE_CMD[@]+"${COMPOSE_CMD[@]}"} ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"
}

# ---- 容器状态读取 ----
# 🔴 一律 docker inspect 读结构化字段,不解析 `docker-compose ps` 的文本 ——
#    unhealthy 在 compose 1.29.2 的 ps 输出里怎么呈现没在那个版本上验证过。
container_id() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null | head -n 1 || true)"
  # 停掉的容器:v2 的 `ps -q` 默认只列运行中的,退一步用 -a 再问一次
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
run_status() {
  local cid
  cid="$(container_id "$1")"
  if [ -z "$cid" ]; then printf 'absent'; return 0; fi
  docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || printf 'absent'
}

_die_not_healthy() {
  local svc="$1" secs="$2" cid
  cid="$(container_id "$svc")"
  log_err "${svc} 在 ${secs}s 内没有变成 healthy,下面是它最近 50 行日志:"
  if [ -n "$cid" ]; then docker logs --tail 50 "$cid" 2>&1 | tee -a "$LOG_FILE" || true; fi
  # 锚点写成字面量,不用变量拼 —— 拼出来的锚点 grep 抓不到,写文档时就会漏掉对应小节。
  case "$svc" in
    pg)     die "pg 启动超时未健康" pg-not-healthy ;;
    etcd)   die "etcd 启动超时未健康" etcd-not-healthy ;;
    minio)  die "minio 启动超时未健康" minio-not-healthy ;;
    milvus) die "milvus 启动超时未健康" milvus-not-healthy ;;
    *)      die "${svc} 启动超时未健康" ;;
  esac
}

# wait_healthy SVC TIMEOUT
wait_healthy() {
  local svc="$1" timeout="$2" waited=0 interval="${STACK_POLL_INTERVAL:-3}" st
  st="$(health_status "$svc")"
  if [ "$st" = "healthy" ]; then
    log_info "${svc} 已经是 healthy,跳过等待"
    return 0
  fi
  log_info "等待 ${svc} healthy(超时 ${timeout}s,当前 ${st})…"
  while [ "$(health_status "$svc")" != "healthy" ]; do
    if [ "$waited" -ge "$timeout" ]; then
      _die_not_healthy "$svc" "$timeout"
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
  log_info "${svc} healthy(等了约 ${waited}s)"
}

# ---- /healthz ----
HEALTH_PORT="${TASK_RUNTIME_PORT:-18080}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/healthz"
# healthz_ok —— 探一次;绿了就把响应体打到 stdout 并返回 0,否则返回 1。
# 🔴 用 python3 解析 JSON,不用 grep 匹配 '"ok":true' 字符串:那种粗糙匹配会被
#    塞进 errorMessage 里的同样文本骗到,把"报错"读成"健康"。
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

# ============================================================================
# 第 2 步 · pull 五个镜像
# ============================================================================
log_info "---- 2/6 拉镜像(五个)----"
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] ${COMPOSE_CMD[*]+"${COMPOSE_CMD[*]}"} ${COMPOSE_ARGS[*]+"${COMPOSE_ARGS[*]}"} pull"
else
  log_info "+ compose pull"
  if ! compose pull; then
    die "拉镜像失败 —— 多半是没登录 registry、镜像 tag 打错,或网络/证书不通" pull-failed
  fi
fi

# ============================================================================
# 第 3 步 · 起数据层四个容器,等到全部 healthy
# ============================================================================
log_info "---- 3/6 起数据层 pg / etcd / minio / milvus ----"
compose_run up -d pg etcd minio milvus
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 然后逐个轮询到 healthy:etcd / minio / pg 各 ${STACK_HEALTH_TIMEOUT:-300}s,milvus ${MILVUS_HEALTH_TIMEOUT:-300}s(首次起要 90s+)"
else
  # 顺序:etcd/minio 先绿(milvus 依赖它们),再 pg,最后 milvus。
  # 已经 healthy 的会在 wait_healthy 里直接短路 —— 这就是"重跑安全"的那一半。
  wait_healthy etcd   "${STACK_HEALTH_TIMEOUT:-300}"
  wait_healthy minio  "${STACK_HEALTH_TIMEOUT:-300}"
  wait_healthy pg     "${STACK_HEALTH_TIMEOUT:-300}"
  wait_healthy milvus "${MILVUS_HEALTH_TIMEOUT:-300}"
  log_info "数据层四个容器全部 healthy"
fi

# ============================================================================
# 第 4 步 · 建库(alembic / seed / Milvus collection)
# ============================================================================
# 三段各自在 init.sh 内部按真实状态短路(alembic 是否已在 head、字典表有没有行、
# collection 在不在),重跑不会重建、不会产生重复行、不会碰已灌的语料。
log_info "---- 4/6 建库(三段幂等,已建好的会自己短路)----"
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] ${COMPOSE_CMD[*]+"${COMPOSE_CMD[*]}"} ${COMPOSE_ARGS[*]+"${COMPOSE_ARGS[*]}"} run --rm --entrypoint /app/deploy/init.sh pi"
else
  log_info "+ compose run --rm --entrypoint /app/deploy/init.sh pi"
  if ! compose run --rm --entrypoint /app/deploy/init.sh pi; then
    die "建库失败 —— 上面 init.sh 的输出里写着是哪一段挂了" init-failed
  fi
fi

# ============================================================================
# 第 5 步 · 起 pi,等 /healthz
# ============================================================================
log_info "---- 5/6 起 pi ----"
compose_run up -d pi
SERVE_TIMEOUT="${SERVE_HEALTH_TIMEOUT:-120}"
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 然后轮询 ${HEALTH_URL} 最多 ${SERVE_TIMEOUT}s,用 python3 解析 JSON 判 ok 是不是 true"
else
  log_info "等待 ${HEALTH_URL} 返回 ok:true(超时 ${SERVE_TIMEOUT}s)…"
  HEALTHZ_BODY=""
  waited=0
  while true; do
    if HEALTHZ_BODY="$(healthz_ok)"; then
      log_info "pi healthy(等了约 ${waited}s):${HEALTHZ_BODY}"
      break
    fi
    if [ "$waited" -ge "$SERVE_TIMEOUT" ]; then
      PI_CID="$(container_id pi)"
      log_err "pi 在 ${SERVE_TIMEOUT}s 内没有返回 ok:true,下面是它最近 50 行日志:"
      if [ -n "$PI_CID" ]; then docker logs --tail 50 "$PI_CID" 2>&1 | tee -a "$LOG_FILE" || true; fi
      die "pi 容器起来了但 /healthz 不绿" serve-not-healthy
    fi
    sleep 3
    waited=$((waited + 3))
  done
fi

# ============================================================================
# 第 6 步 · 摘要
# ============================================================================
log_info "---- 6/6 摘要 ----"
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 最后会打印:五个容器的 State.Status / State.Health.Status、pi 镜像、/healthz 响应体、卷占用与宿主磁盘"
  log_info "[dry-run] 预演结束 —— 没有起过任何容器、没有拉过任何镜像、没有动过任何卷"
  exit 0
fi

for svc in pg etcd minio milvus pi; do
  log_info "  ${svc}: $(run_status "$svc") / $(health_status "$svc")"
done
PI_CID="$(container_id pi)"
if [ -n "$PI_CID" ]; then
  log_info "  pi 镜像: $(docker inspect -f '{{.Config.Image}}' "$PI_CID" 2>/dev/null || echo 未知)"
fi
if HEALTHZ_BODY="$(healthz_ok)"; then
  log_info "  /healthz: ${HEALTHZ_BODY}"
else
  log_warn "  /healthz: 探不到,或返回的不是 ok:true —— 跑 ./status.sh 看细节"
fi
log_info "  卷占用(docker system df):"
docker system df 2>&1 | sed 's/^/    /' | tee -a "$LOG_FILE" || true
log_info "  宿主磁盘:"
df -h / 2>&1 | sed 's/^/    /' | tee -a "$LOG_FILE" || true

log_info "==== deploy.sh 完成 —— 日志:${LOG_FILE} ===="
