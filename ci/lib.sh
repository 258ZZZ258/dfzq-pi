#!/usr/bin/env bash
# ci/lib.sh —— 六个 CI 脚本的公共部分。被 source,不直接执行。
#
# 🔴 设计约定(2026-08-26,应运维要求把六个 stage 从 Jenkinsfile 拆成纯 sh):
#   · 每个脚本都能**脱离 Jenkins 手工跑**:在 master 上按 01→06 的顺序敲,效果与
#     Jenkins 完全一致。Jenkinsfile 只是六句 `bash ci/0X-*.sh` 的薄壳。
#   · 所有参数走环境变量,带缺省值;Jenkins 的 environment 块与手工 export 都能覆盖。
#   · 脚本自己定位仓库根,不依赖调用者的 cwd。
#   · 🔴 这些脚本活在 git 里。在 Jenkins workspace 里手改是没用的 —— 每次构建
#     checkout 会盖掉;要改就走仓库(这不是限制,是防"现场偏离没人记得"的保险)。

set -eu

# ---- 定位仓库根 --------------------------------------------------------------
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CI_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ---- 日志 --------------------------------------------------------------------
log()  { printf '[ci] %s\n' "$*"; }
die()  { printf '[ci] ✗ %s\n' "$*" >&2; exit 1; }

# ---- 参数(全部可被环境变量覆盖)---------------------------------------------
REGISTRY="${REGISTRY:-${DFZQ_REGISTRY:-jfrog.orientsec.com.cn/dev7-docker-release-local}}"
# L0 tag:人工递增(node22-r1 → r2…),改这个缺省值走 git。
RUNTIME_BASE_TAG="${RUNTIME_BASE_TAG:-${DFZQ_RUNTIME_BASE_TAG:-node22-r1}}"
# L1 tag 解析顺序:显式 env > ci/00-ensure-base.sh 写的 .ci/BASE_TAG > 空(require 时报错)。
BASE_TAG="${BASE_TAG:-${DFZQ_BASE_TAG:-}}"
BASE_TAG_FROM_FILE=0
if [ -z "$BASE_TAG" ] && [ -f .ci/BASE_TAG ]; then BASE_TAG="$(cat .ci/BASE_TAG)"; BASE_TAG_FROM_FILE=1; fi
PLATFORM="${PLATFORM:-${DFZQ_PLATFORM:-}}"

# 排练栈:固定 project 名 + 固定端口 ⇒ 必须串行(Jenkins 靠 disableConcurrentBuilds,
# 手工跑靠人)。四个端口要与 deploy/compose.rehearsal.yml 里写死的那四条**逐字相同**——
# compose 多文件合并时 ports 是**追加**语义,两边解析出同一条映射才会被去重合成一条;
# 漏设就会把 compose.yml 的缺省端口(5432/19530/9091/18080)也发布到宿主。
REHEARSAL_PROJECT="${REHEARSAL_PROJECT:-dfzq-rehearsal}"
REH_PG_PORT="${REH_PG_PORT:-15432}"
REH_MILVUS_PORT="${REH_MILVUS_PORT:-29530}"
REH_MILVUS_HEALTH="${REH_MILVUS_HEALTH:-29091}"
REH_PI_PORT="${REH_PI_PORT:-28080}"
# COMPOSE_FILES 可覆盖:本机自测时排练 override 里硬编码的端口可能撞上本机常驻栈,
# 可只用主文件 + 环境变量端口(COMPOSE_FILES="-f deploy/compose.yml")。CI 上不要动。
COMPOSE_FILES="${COMPOSE_FILES:--f deploy/compose.yml -f deploy/compose.rehearsal.yml}"

# ---- compose 命令探测 --------------------------------------------------------
# 🔴 不能只看退出码:Docker 18.06(master 实测)对 `docker compose version` 这种
#    未知命令**打印整页帮助并退出 0**,必须验证输出里真有 "Docker Compose" 字样。
# 探测结果缓存在 .ci/compose-cmd(01 写,其余读);缓存不在就重探,
# 所以单独手工跑 05 也不必先跑 01。
compose_cmd() {
  if [ -f .ci/compose-cmd ]; then cat .ci/compose-cmd; return 0; fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  elif docker compose version 2>/dev/null | grep -q "Docker Compose"; then
    echo "docker compose"
  else
    die "既没有 docker-compose 独立二进制,也没有真正可用的 docker compose 子命令。
  修法(推荐,与生产同版本、排练顺带真验 1.29.2 的解析):
    scp root@<生产机>:/usr/local/bin/docker-compose /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose && docker-compose version"
  fi
}

require_base_tag() {
  [ -n "$BASE_TAG" ] || die "BASE_TAG 未定 —— 正常情况它由 ci/00-ensure-base.sh 算出并写进 .ci/BASE_TAG。
  先跑:bash ci/00-ensure-base.sh(CI 由 stage 0 自动跑)
  或显式指定:BASE_TAG=<audit-ai sha7> bash ci/$(basename "$0")"
}
