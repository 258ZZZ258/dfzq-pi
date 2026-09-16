#!/usr/bin/env bash
# 05-rehearse.sh —— 排练栈:起五个容器 → 建库 → /healthz 绿 → 无论成败拆干净。
#
#   bash ci/05-rehearse.sh          完整排练(结束时自动 down -v,排练卷是一次性的)
#   bash ci/05-rehearse.sh --down   只拆栈(Jenkins 的 post 与手工善后都用它)
#
# 排练栈与生产栈靠 COMPOSE_PROJECT_NAME 隔离(容器/卷名自动带前缀),端口靠
# compose.rehearsal.yml + 四个环境变量隔离。
source "$(dirname "$0")/lib.sh"
COMPOSE="$(compose_cmd)"

# 🔴 这些走**导出的环境变量**,不写进 deploy/.env,两条理由:
#   1. compose 从哪找 .env 做插值,v1(<1.28 看 CWD)与新版(看 project dir)规则
#      不一样 —— 环境变量的优先级在所有版本上都最高,不必赌。
#   2. 🔴 TASK_RUNTIME_PORT 尤其不能进 deploy/.env:那份文件同时是 pi 的 env_file
#      (整份逐行注入容器),而 compose.yml 里端口映射的容器侧与 healthcheck 都硬编码
#      18080。把 28080 注进容器,serve 会去听 28080,映射与 healthz 全对不上、排练必红。
export COMPOSE_PROJECT_NAME="$REHEARSAL_PROJECT"
export PG_PORT="$REH_PG_PORT"
export MILVUS_PORT="$REH_MILVUS_PORT"
export MILVUS_HEALTH_PORT="$REH_MILVUS_HEALTH"
export TASK_RUNTIME_PORT="$REH_PI_PORT"
export PG_PASSWORD="rehearsal"

do_down() {
  set +e
  # 构建若早于本脚本就红了,deploy/.env 可能不存在,而 compose.yml 里
  # ${PI_IMAGE:?}/${PG_PASSWORD:?} 是"未设置即拒绝解析" —— 给哑值让 down 跑完,
  # 不刷一屏与真实失败无关的插值错误。
  export PI_IMAGE="${PI_IMAGE:-unset/unset:unset}"
  export PG_PASSWORD="${PG_PASSWORD:-unset}"
  # 🔴 这条 -v 只对 COMPOSE_PROJECT_NAME=$REHEARSAL_PROJECT 这一套卷生效,
  #    生产栈是别的 project 名,天然碰不到。生产栈**永远不许** down -v。
  $COMPOSE $COMPOSE_FILES down -v --remove-orphans
  rm -f deploy/.env
  echo "=== 排练栈残留检查 ==="
  docker volume ls | grep "$REHEARSAL_PROJECT" || echo "无残留卷"
  docker ps -a --format '{{.Names}}' | grep "$REHEARSAL_PROJECT" || echo "无残留容器"
  set -e
}

if [ "${1:-}" = "--down" ]; then do_down; exit 0; fi

SHORT_SHA="$(cat .ci/SHORT_SHA 2>/dev/null || true)"
[ -n "$SHORT_SHA" ] || die "缺 .ci/SHORT_SHA —— 先跑 ci/04-build-image.sh"
export PI_IMAGE="${REGISTRY}/dfzq-pi:${SHORT_SHA}"

# 无论成败都拆干净(A7):排练卷是一次性的,留着只占磁盘。
trap do_down EXIT

# 上一次可能留下残壳(比如构建被中止)。先清一遍。
$COMPOSE $COMPOSE_FILES down -v --remove-orphans || true

# ---- 排练用 deploy/.env -----------------------------------------------------
# compose.yml 的 pi 写的是 env_file: ./.env,文件不在整份 compose 直接解析失败,
# 所以必须现造一份。它只活在 workspace(.env 在 .gitignore 内),不是交付物。
# 🔴 **不设置**三个网关的地址与 key(D-6):CI 不依赖外部服务,排练只到「建库 +
#    /healthz 绿」;端到端冒烟留在 predeploy 的 55-smoke.sh。
# ⚠ LLM_API_KEY 要给占位值 —— entrypoint 对它 fail-closed 校验,而排练不发起 run。
# 🔴 刻意不写 TASK_RUNTIME_SPECS_DIR/PROFILE/WORK_ROOT:镜像 ENV 已有自洽的一套,
#    env_file 优先级更高,重复只会制造对不上的机会。同理不写端口与 project 名。
# ⚠ 行尾不要写注释:env_file 的解析**不剥**行尾注释。
# 授权 keys 是 RSA 公钥 PEM(RS256 验签)—— 排练现生成一次性密钥对,公钥按 JSON
# 字符串转义(\n)后单行塞进 env。私钥用完即弃:排练不签发任何 grant。
REH_KEY_DIR="$(mktemp -d)"
openssl genrsa -out "$REH_KEY_DIR/k.pem" 2048 2>/dev/null
REH_PUB_ESC="$(openssl rsa -in "$REH_KEY_DIR/k.pem" -pubout 2>/dev/null | awk 'BEGIN{ORS="\\n"} {print}')"
rm -rf "$REH_KEY_DIR"

cat > deploy/.env <<REHEARSAL_ENV
PI_IMAGE=${PI_IMAGE}
TASK_RUNTIME_INTERNAL_TOKEN=dfzq-rehearsal-no-auth
PIPELINE_DB_DSN=postgresql+psycopg://pipeline:rehearsal@pg:5432/audit_pipeline
LLM_API_KEY=rehearsal-placeholder-never-called
POLICY_MCP_AUDIT_LOG=/data/logs/policy-mcp-audit.jsonl
HF_HUB_OFFLINE=1
PIPELINE_MILVUS_HOST=milvus
PIPELINE_MILVUS_PORT=19530
PIPELINE_EMBEDDING_MODE=endpoint
PIPELINE_SPARSE_BACKEND=bm25
QUERY_RERANK_BACKEND=api
QUERY_LLM_BACKEND=stub
PG_PASSWORD=rehearsal
AUTH_ISSUER=rehearsal
AUTH_AUDIENCE=rehearsal
AUTH_KEYS_JSON={"r1":"${REH_PUB_ESC}"}
REHEARSAL_ENV
chmod 600 deploy/.env

# ---- 等 healthy --------------------------------------------------------------
# 判据直接读 docker inspect 的 State.Health.Status,不解析 compose ps 的文本
# (1.29.2 与 v2 的 ps 输出形态不一样,规格 §3.1 的同一条纪律)。
wait_healthy() {
  svc="$1"; budget="$2"
  deadline=$(( $(date +%s) + budget ))
  while : ; do
    cid="$($COMPOSE $COMPOSE_FILES ps -q "$svc" | head -1)"
    if [ -n "$cid" ]; then
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$cid" 2>/dev/null || echo gone)"
      [ "$st" = "healthy" ] && { log "✓ ${svc} healthy"; return 0; }
    else
      st="容器还没建出来"
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "✗ ${svc} 在 ${budget}s 内没到 healthy,最后状态:${st}"
      [ -n "${cid:-}" ] && docker logs --tail 80 "$cid" 2>&1 || true
      return 1
    fi
    sleep 5
  done
}

log "=== 起四个数据层 ==="
$COMPOSE $COMPOSE_FILES up -d pg etcd minio milvus
# milvus 的 start_period 是 90s,且它 depends_on etcd/minio 都 healthy,
# 等到 milvus healthy 就等价于四个数据层全绿。
wait_healthy pg 300
wait_healthy milvus 300

log "=== 建库(init.sh 三段,各自幂等)==="
$COMPOSE $COMPOSE_FILES run --rm --entrypoint /app/deploy/init.sh pi

log "=== 起 pi ==="
$COMPOSE $COMPOSE_FILES up -d pi
PI_CID="$($COMPOSE $COMPOSE_FILES ps -q pi | head -1)"
[ -n "$PI_CID" ] || die "pi 容器没起来"

log "=== 轮询 /healthz(超时 120s)==="
# 从容器内 curl,不依赖主节点有 curl;镜像里 curl 是 HEALTHCHECK 的依赖,一定在。
deadline=$(( $(date +%s) + 120 ))
while : ; do
  body="$(docker exec "$PI_CID" curl -fsS http://127.0.0.1:18080/healthz 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    log "✓ /healthz 绿:${body}"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "✗ /healthz 在 120s 内没绿。最后一次响应体:${body:-<空,连不上>}"
    docker inspect -f '容器状态 {{.State.Status}} / 健康 {{if .State.Health}}{{.State.Health.Status}}{{else}}无{{end}}' "$PI_CID" || true
    docker logs --tail 120 "$PI_CID" 2>&1 || true
    exit 1
  fi
  sleep 5
done

# 顺带确认端口真的发布到了宿主;主节点不一定有 curl,失败只记一行、不作判据。
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 5 "http://127.0.0.1:${REH_PI_PORT}/healthz" \
    && log "  ↑ 宿主 127.0.0.1:${REH_PI_PORT} 上也拿到了" \
    || log "  ⚠ 宿主 127.0.0.1:${REH_PI_PORT} 没拿到(端口映射?)—— 不作判据,仅记账"
fi

log "=== 排练栈全绿(结束后 trap 自动 down -v)==="
$COMPOSE $COMPOSE_FILES ps
