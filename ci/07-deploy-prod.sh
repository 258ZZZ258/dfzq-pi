#!/usr/bin/env bash
# 07-deploy-prod.sh —— 全自动 CD:排练绿 + 镜像已推之后,把同一个 sha 部署到生产(74)。
#
# 决策 D-14(2026-08-30,用户拍板"每次绿了就上"):
#   dfzq/intranet 的每次绿构建自动上线生产。已知代价(明示接受):部署瞬间正在跑的
#   run 会被打断(启动恢复逻辑将其标 error),业务人员正问的问题会失败。
#   🔴 临时暂停 CD:Jenkins 全局变量加 DFZQ_NO_PROD_DEPLOY=1,不必改代码。
#
# 凭证:Jenkins 的 sshUserPrivateKey(dfzq-build-ssh)注入 SSH_KEY(私钥文件路径)——
# 就是旧 rsync 流水线退役时刻意保留的那对凭证/变量,在此重新启用。
# 手工跑:不设 SSH_KEY 则用默认 ssh 身份(~/.ssh 或 agent)。
source "$(dirname "$0")/lib.sh"

SHORT_SHA="$(cat .ci/SHORT_SHA 2>/dev/null || true)"
[ -n "$SHORT_SHA" ] || die "缺 .ci/SHORT_SHA —— 先跑 ci/04-build-image.sh"

if [ "${DFZQ_NO_PROD_DEPLOY:-0}" = "1" ]; then
  log "DFZQ_NO_PROD_DEPLOY=1 —— CD 已暂停,跳过生产部署(镜像 ${SHORT_SHA} 已在仓,随时可手动 deploy.sh --tag)"
  exit 0
fi

HOST="${DFZQ_BUILD_HOST:-root@10.46.51.74}"
SSH_OPTS="-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10${SSH_KEY:+ -i $SSH_KEY}"
PI_DIR=/root/dfzq-src/dfzq-pi

# ---- 门 1:74 可达 ----------------------------------------------------------
ssh $SSH_OPTS "$HOST" true 2>/dev/null \
  || die "连不上生产机 ${HOST} —— 检查 Jenkins 凭证 dfzq-build-ssh 与网络"

# ---- 门 2:74 已切容器化 -----------------------------------------------------
# 判据 = deploy/.env 存在(首次切换时人工创建,见 RUNBOOK §5)。
# 🔴 没切完是**响亮跳过而不是红**:首次生产切换是人工动作(停老 serve、写凭证、
#    确认卷复用),CD 不越权替人做;切换前的每次构建也不该因此挂红。
if ! ssh $SSH_OPTS "$HOST" "test -f $PI_DIR/deploy/.env"; then
  log "⚠ 74 尚未完成容器化首次切换($PI_DIR/deploy/.env 不存在)—— 跳过自动部署。"
  log "  首次切换按 RUNBOOK-agent-内网部署.md §5 人工执行;切换完成后 CD 自动生效。"
  exit 0
fi

# ---- 同步 deploy/(compose/脚本要跟着版本走;--exclude .env 保住生产凭证)----
log "同步 deploy/ → ${HOST}:${PI_DIR}/deploy/(不含 .env)"
rsync -az --exclude '.env' --exclude 'logs' -e "ssh $SSH_OPTS" \
  deploy/ "$HOST:$PI_DIR/deploy/"

# ---- 部署:deploy.sh 自带 pull/up/init 幂等与 /healthz 轮询,红了本 stage 即红 ----
log "生产部署:deploy.sh --tag ${SHORT_SHA}"
ssh $SSH_OPTS "$HOST" "bash $PI_DIR/deploy/ops/deploy.sh --tag $SHORT_SHA"
log "✓ 生产已更新到 dfzq-pi:${SHORT_SHA}(回滚:同命令指旧 tag)"
