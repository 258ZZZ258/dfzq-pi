#!/usr/bin/env bash
# entrypoint.sh —— pi 容器的 ENTRYPOINT。五步(规格 §3.2):
#   1 require_env 六项 + LLM_API_KEY
#   2 mkdir -p /data/work /data/logs /data/config
#   3 渲染 settings.toml(复制镜像里的 config/ 到 /data/config,改副本,再改指向)
#   4 渲染 gateway.json 到 /data/config/gateway.json
#   5 exec node --experimental-strip-types .../cli/main.ts serve
#
# 规格:dfzq-pi开发任务/骨架/规格-容器化与一键部署.md §3.2。
# 日志只走 stdout/stderr —— 容器里的日志出口是 `docker logs`,不另写文件
# (与 predeploy 的 lib.sh 不同:那边跑在宿主,要落 logs/*.log)。
# 🔴 不 source predeploy 的 scripts/lib.sh —— 容器里没有那个仓,log/die 在本文件内自带。
#
# ── 🔴 为什么必须渲染 settings.toml,而不是"配好环境变量就行" ────────────────
# 已逐行核对 <audit-ai> 的两处 _apply_env(这是全仓仅有的两个 env 覆盖入口):
#   · pipeline/pipeline/config.py::_apply_env —— 处理 PIPELINE_DB_DSN → db.dsn、
#     PIPELINE_MILVUS_HOST → milvus.host、PIPELINE_EMBEDDING_* / PIPELINE_SPARSE_BACKEND
#     → embedding.*,**没有任何一行处理 milvus.port**(全仓 grep PIPELINE_MILVUS_PORT
#     在 audit-ai 零命中);而 MilvusIO.connect() 用的是 `self.cfg.port`
#     (= settings.milvus.port,pipeline/pipeline/index/milvus_io.py:140),唯一来源就是
#     settings.toml。⇒ port 只能靠渲染。
#   · query/query/config.py::_apply_env —— [query] 段的 env 覆盖。
# 更要紧的是**这些 env 根本传不进真正干活的那个进程**:query.mcp.server 由 task-runtime
# 以白名单 env spawn(toolsets/mcp/client.ts 的 BASE_ENV_KEYS + spec 里显式列出的),
# specs/policy-query.json 的 mcpServers[0].env 只转发四项:
#     PIPELINE_CONFIG_DIR / POLICY_MCP_AUDIT_LOG / PIPELINE_SPARSE_BACKEND / HF_HUB_OFFLINE
# (外加 PATH)。PIPELINE_EMBEDDING_BASE_URL / QUERY_RERANK_* 一个都不在里面 ⇒ 它们
# 要生效,唯一通道就是被写进 PIPELINE_CONFIG_DIR 指向的那份 settings.toml。
#
# 🔴 已核到的一处缺口(不在本文件能修的范围内,记在这里)——
#   query/query/config.py::load_query_config 读的是 **QUERY_CONFIG_DIR**(不是
#   PIPELINE_CONFIG_DIR),缺省回落 <repo>/config = /opt/audit-ai/config。
#   而 specs/policy-query.json 的 env 白名单里没有 QUERY_CONFIG_DIR ⇒ 本脚本渲染进
#   /data/config/settings.toml 的 **[query] 段对 MCP 子进程无效**,子进程会去读镜像层
#   里那份没渲染过的 /opt/audit-ai/config/settings.toml([query] 全是出厂值:
#   rerank_backend="none"、llm_backend="stub")。
#   处置需要改 specs/policy-query.json 的 mcpServers[0].env,补一行
#       "QUERY_CONFIG_DIR": "${QUERY_CONFIG_DIR}"
#   ——那是别人的文件,本脚本只做两件事:照样渲染 [query] 段(改好 spec 后立刻生效,
#   且 pi 容器内其它直接跑 query 的进程本来就吃得到),以及在下面做一次检查、
#   转发缺失时打一条响亮的 WARN,不让它静默。
#
# ── 🔴 为什么复制到 /data/config 改副本,而不是原地改 /opt/audit-ai/config ──────
#   · 镜像层是只读语义:原地改会让"镜像 + .env"这两个输入之外多出一份可变状态。
#   · restart: unless-stopped 会让本脚本在每次容器重启时重跑。复制-再改是幂等的
#     (每次都从镜像那份原稿重新出发);原地改则是"在上次改过的结果上再改一次",
#     正则替换类的改写在这种叠加下迟早出错。
#   · 出厂原稿留在 /opt/audit-ai/config 里没被动过,现场排查时可以直接 diff 两份。
#
# ── ⚠ gateway.json 的 cost 全 0 ────────────────────────────────────────────
#   内网网关不计费,cost 四项都填 0。后果:specs/policy-query.json 的
#   limits.maxCostUsd(0.5)永远不会触发(0 乘任何 token 数还是 0),
#   runTimeoutMs(900000)是唯一还在生效的护栏。这条承 predeploy conf/.env 的同一段说明。
#
# 环境变量开关:
#   DRY_RUN=1   只打印将做什么,不建目录、不渲染、不 exec。
#               ⚠ require_env 照常执行 —— "配置本身缺失,dry-run 也该照样暴露"
#               (与 45-init-db.sh 的 dry-run 同一条语义)。
#
# ANCHORS: missing-env config-src-missing settings-render-failed profile-render-failed profile-path-mismatch unexpected-args
set -euo pipefail

# ── 最小日志实现(对齐 predeploy scripts/lib.sh 的 log_info/log_warn/die)──────
# redact:把 `scheme://user:pass@host` 的口令段打码。日志出口只有 _log_line 一个,
# 判据挂在边界上("凡是要写进日志的一行都先过脱敏"),不挂"哪些变量名算敏感"的清单。
_redact() {
  printf '%s' "$1" | sed -E 's#([a-zA-Z][a-zA-Z0-9+.-]*://[^/@[:space:]]*):[^/@[:space:]]*@#\1:***@#g'
}
_log_line() {
  local level="$1" msg
  msg="$(_redact "$2")"
  printf '[%s] [%s] [entrypoint] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$msg"
}
log_info() { _log_line INFO "$1"; }
log_warn() { _log_line WARN "$1" >&2; }
log_err()  { _log_line ERR  "$1" >&2; }

# die MSG [ANCHOR] —— 打印后 exit 1;带锚点时追加运维手册指针。
die() {
  local msg="$1" anchor="${2:-}"
  if [ -n "$anchor" ]; then
    msg="${msg} → 见 deploy/ops/README.md#${anchor}"
  fi
  log_err "$msg"
  exit 1
}

# require_env NAME... —— 逐个断言非空。🔴 空串与未设置同等对待,与
# packages/task-runtime/src/cli/serve.ts 的 requireEnv 同一口径
# (`TASK_RUNTIME_INTERNAL_TOKEN=` 这种写法在 shell 里太容易出现,
#  把它当"已配置"就是无鉴权上线)。
require_env() {
  local name missing=()
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      missing+=("$name")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "缺少必填环境变量:${missing[*]}(未设置或为空串,两者同等对待)——检查 deploy/.env" missing-env
  fi
}

# ── 常量 ──────────────────────────────────────────────────────────────────
AUDIT_ROOT="${DFZQ_AUDIT_AI_ROOT:-/opt/audit-ai}"
# 🔴 源目录刻意**不**取自 $PIPELINE_CONFIG_DIR:那个变量可能被 .env 覆盖成
# /data/config,那样就会变成"把 /data/config 复制到 /data/config",既没意义也危险。
# 源永远是镜像里的原稿。
SRC_CONFIG_DIR="${AUDIT_ROOT}/config"
DATA_ROOT=/data
DST_CONFIG_DIR="${DATA_ROOT}/config"
GATEWAY_JSON="${DST_CONFIG_DIR}/gateway.json"
SERVE_ENTRY=/app/packages/task-runtime/src/cli/main.ts
PY="${DFZQ_AUDIT_AI_PYTHON:-/opt/venv/bin/python}"
DRY_RUN="${DRY_RUN:-0}"

# 参数:本脚本不接受任何位置参数。静默忽略是这套代码最不想要的行为 —— 想在容器里
# 跑别的东西请用 `--entrypoint`(init.sh 就是这么跑的)。
if [ "$#" -gt 0 ]; then
  die "entrypoint.sh 不接受参数(收到:$*)。要在本镜像里跑别的命令请用 docker-compose run --rm --entrypoint <程序> pi" unexpected-args
fi

# ── 1/5 require_env ────────────────────────────────────────────────────────
# 🔴 六项来自 serve.ts 当前的 requireEnv(commit 36ebcfff 之后)。
#    TASK_RUNTIME_DB_PATH **不在其中**:server/main.ts:50 明写
#    "SQLite task storage has been removed",那是个死变量,不要 require。
# LLM_API_KEY 单列:它不由 serve.ts 的 requireEnv 把关,而是由
# env/provider-profile.ts::requireApiKey 在装配期 fail-closed(gateway.json 的
# apiKeyEnv 指向它)。放在这里是为了让"缺 key"在容器启动这一刻就红,而不是等到
# 第一次真实提问才炸。
log_info "1/5 校验必填环境变量…"
require_env \
  AUTH_ISSUER \
  AUTH_AUDIENCE \
  AUTH_KEYS_JSON \
  TASK_RUNTIME_INTERNAL_TOKEN \
  TASK_RUNTIME_PORT \
  PIPELINE_DB_DSN \
  TASK_RUNTIME_SPECS_DIR \
  TASK_RUNTIME_PROFILE \
  TASK_RUNTIME_WORK_ROOT \
  LLM_API_KEY
log_info "必填项齐全(六项 serve requireEnv + LLM_API_KEY)"

# 这两项不是 serve 的 requireEnv,但缺了会让 settings.toml 沿用出厂的
# localhost:19530 —— 在容器网络里那是错的(要连的是服务名 milvus)。不 die,响亮 WARN。
[ -n "${PIPELINE_MILVUS_HOST:-}" ] || log_warn "PIPELINE_MILVUS_HOST 未设置:settings.toml 的 [milvus].host 将沿用出厂值 localhost —— 容器网络里连不到 milvus 服务(compose.yml 的 pi.environment 本应把它设成 milvus)"
[ -n "${PIPELINE_MILVUS_PORT:-}" ] || log_warn "PIPELINE_MILVUS_PORT 未设置:settings.toml 的 [milvus].port 将沿用出厂值 19530;该值**无法**用环境变量覆盖(pipeline/config.py::_apply_env 不处理它),只能靠本脚本渲染"

if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 以下步骤只打印、不执行:"
  log_info "[dry-run]   2/5 mkdir -p ${DATA_ROOT}/work ${DATA_ROOT}/logs ${DST_CONFIG_DIR}"
  log_info "[dry-run]   3/5 cp -a ${SRC_CONFIG_DIR}/. ${DST_CONFIG_DIR}/ 后渲染 settings.toml 的 [db]/[milvus]/[embedding]/[query],再 export PIPELINE_CONFIG_DIR=${DST_CONFIG_DIR} QUERY_CONFIG_DIR=${DST_CONFIG_DIR}"
  log_info "[dry-run]   4/5 渲染 ${GATEWAY_JSON}(baseUrl/modelId/contextWindow/maxTokens/reasoning ← LLM_*)"
  log_info "[dry-run]   5/5 exec node --experimental-strip-types ${SERVE_ENTRY} serve"
  exit 0
fi

# ── 2/5 建目录 ─────────────────────────────────────────────────────────────
# work root(TASK_RUNTIME_WORK_ROOT)、MCP 审计日志目录(POLICY_MCP_AUDIT_LOG 的父目录)、
# 渲染产物落点。三者都在 runtime_data 卷的 /data 上,容器重建不丢。
log_info "2/5 建目录 ${DATA_ROOT}/{work,logs,config}…"
mkdir -p "${DATA_ROOT}/work" "${DATA_ROOT}/logs" "$DST_CONFIG_DIR"
chmod 700 "$DST_CONFIG_DIR"

# ── 3/5 渲染 settings.toml ─────────────────────────────────────────────────
log_info "3/5 渲染 settings.toml:${SRC_CONFIG_DIR} → ${DST_CONFIG_DIR}…"
[ -d "$SRC_CONFIG_DIR" ] || die "镜像里没有 ${SRC_CONFIG_DIR} —— 底座镜像的 COPY audit-ai/config/ 那一层缺了?" config-src-missing
[ -f "${SRC_CONFIG_DIR}/settings.toml" ] || die "缺 ${SRC_CONFIG_DIR}/settings.toml" config-src-missing
[ "$SRC_CONFIG_DIR" != "$DST_CONFIG_DIR" ] || die "源与目标配置目录相同(${SRC_CONFIG_DIR}),拒绝原地改镜像层" config-src-missing

# 四个文件一起复制:load_config() 读 settings.toml + qc_thresholds.yaml +
# obligation.yaml + profiles.yaml,只复制 settings.toml 会让另外三个在新的
# PIPELINE_CONFIG_DIR 下找不到(pipeline/config.py:203-206 是四次 read_text,缺一即抛)。
cp -a "${SRC_CONFIG_DIR}/." "${DST_CONFIG_DIR}/"

# 🔴 TOML 改写:容器里是 Python 3.11,tomllib 只读不写(标准库没有 writer)。
# 做法是"正则逐键替换 / 缺键就插进对应段",改完之后**用 tomllib 解析一次并逐键
# 回读比对**——这道回读是真正的判据:段落找错、值写成多行、行尾注释把值吃掉、
# 重复键……任何一种把文件改坏的形态都会在这里翻红,而不是留到 audit-ai 真正
# tomllib.load 时才炸(那时排查链路已经被拉长了)。
if ! "$PY" - "${DST_CONFIG_DIR}/settings.toml" <<'RENDER_SETTINGS_PY'
import json
import os
import re
import sys
import tomllib
from pathlib import Path

path = Path(sys.argv[1])

# ── 映射表:(段, 键, 类型, [env 名…])——后面的 env 名优先,与 audit-ai 自己的
#    _apply_env 覆盖顺序逐行对齐(先写 OPENAI_*、再写 PIPELINE_*/QUERY_*,后者覆盖前者)。
#
# 🔴 判据挂边界,不挂"我觉得重要的几个字段":这张表是把
#    pipeline/pipeline/config.py::_apply_env 与 query/query/config.py::_apply_env
#    两个函数**逐行抄下来**的结果(键名与段名以那两份源码 + config/settings.toml
#    实际内容为准,不照规格文档的描述猜)。上游加一条 env 覆盖,这里照着补一行即可,
#    不需要谁"想起来"某个字段漏了。
#
# ⚠ 刻意不含 [object_store] 段(PIPELINE_OBJECT_STORE_BACKEND / MINIO_*):
#    五容器栈不做灌库,对象存储只在 predeploy 的 60/65/67/70 链路上用,那条链路
#    跑在宿主的完整 shell 环境里,env 覆盖对它是真实生效的。
MAPPING = [
    ("db", "dsn", "str", ["PIPELINE_DB_DSN"]),
    ("milvus", "host", "str", ["PIPELINE_MILVUS_HOST"]),
    # 🔴 port 是整张表里唯一"只能靠渲染"的键:_apply_env 不处理 PIPELINE_MILVUS_PORT。
    ("milvus", "port", "int", ["PIPELINE_MILVUS_PORT"]),
    ("embedding", "mode", "str", ["PIPELINE_EMBEDDING_MODE"]),
    ("embedding", "model_name", "str", ["PIPELINE_EMBEDDING_MODEL"]),
    # sparse_backend 决定 Milvus collection 的形态,且 collection 建好就不再重建。
    ("embedding", "sparse_backend", "str", ["PIPELINE_SPARSE_BACKEND"]),
    ("embedding", "endpoint_base_url", "str", ["OPENAI_BASE_URL", "PIPELINE_EMBEDDING_BASE_URL"]),
    ("embedding", "endpoint_api_key", "str", ["OPENAI_API_KEY", "PIPELINE_EMBEDDING_API_KEY"]),
    ("embedding", "endpoint_model", "str", ["PIPELINE_EMBEDDING_ENDPOINT_MODEL"]),
    ("embedding", "cache_dir", "str", ["HF_HOME"]),
    ("query", "llm_backend", "str", ["QUERY_LLM_BACKEND"]),
    ("query", "rerank_backend", "str", ["QUERY_RERANK_BACKEND"]),
    ("query", "rerank_model", "str", ["QUERY_RERANK_MODEL"]),
    ("query", "rerank_endpoint_base_url", "str", ["QUERY_RERANK_BASE_URL"]),
    ("query", "rerank_endpoint_api_key", "str", ["QUERY_RERANK_API_KEY"]),
    ("query", "rerank_endpoint_path", "str", ["QUERY_RERANK_PATH"]),
    ("query", "rerank_min_score", "float", ["QUERY_RERANK_MIN_SCORE"]),
    ("query", "llm_model", "str", ["OPENAI_MODEL"]),
    ("query", "review_model", "str", ["OPENAI_REVIEW_MODEL", "QUERY_REVIEW_MODEL"]),
    ("query", "merge_context", "bool", ["QUERY_MERGE_CONTEXT"]),
    ("query", "merge_model", "str", ["QUERY_MERGE_MODEL"]),
    ("query", "hyde", "bool", ["QUERY_HYDE"]),
    ("query", "hyde_model", "str", ["QUERY_HYDE_MODEL"]),
    ("query", "decompose", "bool", ["QUERY_DECOMPOSE"]),
    ("query", "decompose_model", "str", ["QUERY_DECOMPOSE_MODEL"]),
    ("query", "batch_retrieve_concurrency", "int", ["QUERY_BATCH_RETRIEVE_CONCURRENCY"]),
    ("query", "observe", "bool", ["QUERY_OBSERVE"]),
    ("query", "docnum_boost", "bool", ["QUERY_DOCNUM_BOOST"]),
    ("query", "scenario_expand", "bool", ["QUERY_SCENARIO_EXPAND"]),
    ("query", "scenario_terms_path", "str", ["QUERY_SCENARIO_TERMS_PATH"]),
    ("query", "summary_llm", "bool", ["QUERY_SUMMARY_LLM"]),
    ("query", "summary_model", "str", ["QUERY_SUMMARY_MODEL"]),
]

TRUE = {"1", "true", "yes", "on"}
FALSE = {"0", "false", "no", "off"}


def fail(msg):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def mask(name, value):
    """名字命中敏感关键字就打码,否则只做 URL userinfo 脱敏(同 lib.sh 的 mask)。"""
    text = str(value)
    upper = name.upper()
    if any(k in upper for k in ("KEY", "TOKEN", "PASSWORD", "SECRET", "DSN")):
        return "***" if len(text) < 6 else f"{text[:2]}***{text[-2:]}"
    return re.sub(
        r"([a-zA-Z][a-zA-Z0-9+.-]*://[^/@\s]*):[^/@\s]*@", r"\1:***@", text
    )


def coerce(kind, raw, env_name):
    """env 的字符串 → (python 值, TOML 字面量)。转不了就 die,不写一个 pydantic
    以后才会拒绝的值进去(那会把报错推迟到进程真正加载配置的时候)。"""
    if kind == "str":
        # json.dumps 的输出正好是合法的 TOML basic string(\" \\ \n \r \t \b \f \uXXXX
        # 这几个转义在两边同义),不需要自己写 TOML 转义。
        return raw, json.dumps(raw)
    if kind == "int":
        try:
            v = int(raw, 10)
        except ValueError:
            fail(f"{env_name}={raw!r} 不是整数(要写进 settings.toml 的整数键)")
        return v, str(v)
    if kind == "float":
        try:
            v = float(raw)
        except ValueError:
            fail(f"{env_name}={raw!r} 不是数值")
        return v, repr(v)
    if kind == "bool":
        low = raw.strip().lower()
        if low in TRUE:
            return True, "true"
        if low in FALSE:
            return False, "false"
        fail(f"{env_name}={raw!r} 不是布尔值(可用:{sorted(TRUE)} / {sorted(FALSE)})")
    fail(f"未知类型 {kind}")


def set_key(lines, section, key, literal):
    """在 [section] 段内把 key 设成 literal。返回新的 lines。

    三种落点,按优先级:段内已有的未注释同名键 → 段内被注释掉的同名键(就地启用,
    保留它在文件里的上下文位置)→ 段头之后。段本身不存在就在文件末尾补一个段。
    """
    head = re.compile(r"^\s*\[\s*" + re.escape(section) + r"\s*\]\s*$")
    any_head = re.compile(r"^\s*\[")
    live = re.compile(r"^\s*" + re.escape(key) + r"\s*=")
    dead = re.compile(r"^\s*#\s*" + re.escape(key) + r"\s*=")
    new_line = f"{key} = {literal}"

    start = None
    for i, line in enumerate(lines):
        if head.match(line):
            start = i
            break
    if start is None:
        return lines + ["", f"[{section}]", new_line]

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if any_head.match(lines[i]):
            end = i
            break

    for i in range(start + 1, end):
        if live.match(lines[i]):
            lines[i] = new_line
            return lines
    for i in range(start + 1, end):
        if dead.match(lines[i]):
            lines[i] = new_line
            return lines
    # 段头之后往下跳过紧邻的注释/空行再插入 —— 那几行通常是这一段的说明,
    # 插在它们前面读起来像是在给上一段做注脚。
    ins = start + 1
    while ins < end and (lines[ins].strip() == "" or lines[ins].lstrip().startswith("#")):
        ins += 1
    return lines[:ins] + [new_line] + lines[ins:]


text = path.read_text(encoding="utf-8")
lines = text.split("\n")

applied = []   # (段, 键, 期望值, 来源 env 名)
skipped = []   # 没设置(或设成空串)的 env 名
for section, key, kind, env_names in MAPPING:
    chosen = None
    for name in env_names:
        raw = os.environ.get(name)
        # 🔴 空串 = 未设置 = 不写(沿用出厂值),与 serve.ts requireEnv 的口径一致。
        # audit-ai 自己的 _apply_env 用的是 `name in env`,会把 `FOO=` 写成空串;
        # 而 compose 的 env_file 里 `PIPELINE_EMBEDDING_ENDPOINT_MODEL=` 这种"登记了
        # 但没填"的写法极常见 —— 照抄 `in env` 会把 endpoint_model 写成 ""(不是 None),
        # 请求体里就多一个 model="" 的字段。这里刻意收严。
        if raw is not None and raw != "":
            chosen = (name, raw)
    if chosen is None:
        skipped.extend(env_names)
        continue
    env_name, raw = chosen
    value, literal = coerce(kind, raw, env_name)
    lines = set_key(lines, section, key, literal)
    applied.append((section, key, value, env_name))

path.write_text("\n".join(lines), encoding="utf-8")

# ── 回读校验:改完之后必须真的能解析,且每个键真的等于期望值 ──────────────
try:
    parsed = tomllib.loads(path.read_text(encoding="utf-8"))
except Exception as e:  # noqa: BLE001 —— 任何解析失败都是同一件事:文件被改坏了
    fail(f"渲染后的 settings.toml 无法被 tomllib 解析:{type(e).__name__}: {e}")

for section, key, value, env_name in applied:
    got = parsed.get(section, {}).get(key, "<缺失>")
    if got != value:
        fail(
            f"回读校验失败:[{section}].{key} 期望 {mask(env_name, value)}、"
            f"实际 {mask(env_name, got)}(来源 {env_name})"
        )

for section, key, value, env_name in applied:
    print(f"  [{section}].{key} = {mask(env_name, value)}   ← {env_name}")
print(f"  已写入 {len(applied)} 个键;未设置而沿用出厂值的 env:{', '.join(sorted(set(skipped))) or '(无)'}")
RENDER_SETTINGS_PY
then
  die "settings.toml 渲染失败(详情见上方原始输出,未被吞掉)" settings-render-failed
fi

chmod 600 "${DST_CONFIG_DIR}/settings.toml"

# 🔴 改指向。PIPELINE_CONFIG_DIR 会被 specs/policy-query.json 转发给 MCP 子进程;
#    QUERY_CONFIG_DIR 目前**不会**(见文件头那条缺口),但仍然 export ——
#    pi 容器里其它直接跑 query 包的进程吃得到,且 spec 补上转发那天这里不用再改。
export PIPELINE_CONFIG_DIR="$DST_CONFIG_DIR"
export QUERY_CONFIG_DIR="$DST_CONFIG_DIR"

# 🔴 把渲染结果回写一份到镜像里的原路径,补上 QUERY_CONFIG_DIR 转发缺口(见文件头)。
#
# 为什么这么修,而不是给 specs/policy-query.json 的 env 白名单加一行:
#   adapter.ts:77 的 ${VAR} 展开是 **fail-closed**(变量未设或为空即抛),
#   加了那一行会让**宿主部署**(没有 QUERY_CONFIG_DIR 的场景)当场起不来。
#
# 为什么回写到 /opt/audit-ai/config 是安全的:
#   query/config.py:17 的 DEFAULT_CONFIG_DIR = <repo>/config,MCP 子进程在
#   QUERY_CONFIG_DIR 未被转发时读的就是这个路径。写入的是**容器可写层**,
#   随容器销毁而消失、每次启动重新渲染 —— 不污染镜像层本身,也不存在两份
#   内容不同的 settings.toml(两处都是同一次渲染的产物)。
if [ -w "$SRC_CONFIG_DIR" ]; then
  cp -f "${DST_CONFIG_DIR}/settings.toml" "${SRC_CONFIG_DIR}/settings.toml"
  log_info "已把渲染后的 settings.toml 回写到 ${SRC_CONFIG_DIR}(MCP 子进程按 DEFAULT_CONFIG_DIR 读的就是这里)"
else
  log_warn "${SRC_CONFIG_DIR} 不可写(只读根文件系统?)—— MCP 子进程会读到未渲染的 settings.toml,[query] 段设置对它不生效"
fi
log_info "PIPELINE_CONFIG_DIR=${PIPELINE_CONFIG_DIR}  QUERY_CONFIG_DIR=${QUERY_CONFIG_DIR}"

# 转发缺口的运行期自查:spec 里没有 QUERY_CONFIG_DIR ⇒ [query] 段渲染对 MCP 子进程无效。
# 只 WARN 不 die —— 缺的是"[query] 段能否生效",不是"服务能不能起来";
# 但必须说出来,不能静默(这正是本仓反复栽过的那类静默配置失效)。
_spec_policy_query="${TASK_RUNTIME_SPECS_DIR}/policy-query.json"
if [ -f "$_spec_policy_query" ] && ! grep -q 'QUERY_CONFIG_DIR' "$_spec_policy_query"; then
  log_warn "${_spec_policy_query} 的 mcpServers[0].env 没有转发 QUERY_CONFIG_DIR —— query.mcp.server 会去读镜像层里未渲染的 ${SRC_CONFIG_DIR}/settings.toml,本次渲染的 [query] 段(rerank_backend / rerank_endpoint_* / llm_backend 等)对它**不生效**。修法:给该 spec 的 env 补一行 \"QUERY_CONFIG_DIR\": \"\${QUERY_CONFIG_DIR}\""
fi

# ── 渲染 auth.json(main 2026-09 起 serve 必填 TASK_RUNTIME_AUTH_CONFIG,fail-closed)──
# GrantConfig = {issuer, audience, keys:{kid:secret}}:Java 调业务路由要带用这些 key
# 签发的 Bearer grant(x-internal-token 仍是第一道门)。AUTH_KEYS_JSON 整个 JSON 对象
# 经 env 传入(env_file 单行、无空格),这里落盘并验形状 —— 坏 JSON 启动期就响亮死。
"$PY" - "$AUTH_ISSUER" "$AUTH_AUDIENCE" "$AUTH_KEYS_JSON" <<'PYAUTH'
import json,sys
iss,aud,keys_raw=sys.argv[1],sys.argv[2],sys.argv[3]
keys=json.loads(keys_raw)
assert isinstance(keys,dict) and keys and all(isinstance(v,str) and v for v in keys.values()),     "AUTH_KEYS_JSON 必须是非空 {kid: secret} 对象"
json.dump({"issuer":iss,"audience":aud,"keys":keys},open("/data/config/auth.json","w"))
PYAUTH
chmod 600 /data/config/auth.json
log_info "auth.json 已渲染(issuer=${AUTH_ISSUER})"

# ── 4/5 渲染 gateway.json ──────────────────────────────────────────────────
# 🔴 用 python 的 json.dump 生成,不用 sed 填模板:模板+sed 那条路要额外做转义与
#    "落盘前 json.load 校验"两件事(predeploy 的 40-config.sh 就是那么做的),
#    而这里根本没有模板文件可填 —— packages/task-runtime/profiles/ 下只有
#    deepseek-cloud.json,gateway.json 在 dfzq-pi 仓里**不存在**(它一直是
#    predeploy 的 conf/gateway.profile.json 模板在宿主上渲染出来的)。
#    直接构造对象再 json.dump,合法性由 json 模块保证。
log_info "4/5 渲染 ${GATEWAY_JSON}…"
if ! "$PY" - "$GATEWAY_JSON" <<'RENDER_PROFILE_PY'
import json
import os
import sys
from pathlib import Path

out = Path(sys.argv[1])
warns = []


def env(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        warns.append(f"{name} 未设置,用占位/缺省值 {default!r}")
        return default
    return raw


def as_int(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        warns.append(f"{name} 未设置,用缺省值 {default}")
        return default
    try:
        return int(raw, 10)
    except ValueError:
        print(f"✗ {name}={raw!r} 不是整数", file=sys.stderr)
        sys.exit(1)


def as_bool(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    low = raw.strip().lower()
    if low in {"1", "true", "yes", "on"}:
        return True
    if low in {"0", "false", "no", "off"}:
        return False
    print(f"✗ {name}={raw!r} 不是布尔值", file=sys.stderr)
    sys.exit(1)


# 占位值刻意用 RFC 2606 保留的 .invalid 域:DNS 必然解析失败,第一次真实调用会
# 响亮报错,而不是悄悄连到某个碰巧存在的地址。
base_url = env("LLM_BASE_URL", "http://llm-base-url-not-configured.invalid")
model_id = env("LLM_MODEL", "llm-model-not-configured")
context_window = as_int("LLM_CONTEXT_WINDOW", 0)
# 4096 是 predeploy conf/gateway.profile.json 用了很久的保守缺省(多数网关的
# 单次输出上限不低于此)。那份模板把它写死、不接 env;这里接上 LLM_MAX_TOKENS,
# 缺省值保持 4096 ⇒ 不填时与既有行为逐字一致。
max_tokens = as_int("LLM_MAX_TOKENS", 4096)
# reasoning 必填且不给"聪明"的默认值是 provider-profile.ts 的明确要求:填 false
# 会让 RuntimeSpec.thinkingLevel 声明的档位被 pi 的 getSupportedThinkingLevels()
# 静默钳成 "off"。这里默认 false(与 predeploy 探测失败时的取值一致),并在下面
# 把实际取值打进日志,让"被钳成 off"这件事至少是可见的。
reasoning = as_bool("LLM_REASONING", False)
# provider 只是注册进 pi 的 ModelRuntime 的一个名字(assembler.ts::resolveModel 用
# 它调 registerProvider,再用同一个名字 getModel),不影响请求形态 —— 请求形态由
# 上面的 api="openai-completions" 决定。缺省沿用 predeploy 模板里的 "openai"。
provider = os.environ.get("LLM_PROVIDER") or "openai"

if context_window == 0:
    warns.append("contextWindow=0 是个哨兵值(网关多半不通过 API 暴露上下文窗口,探不到)——须按网关文档手工填 .env 的 LLM_CONTEXT_WINDOW")

profile = {
    "id": "gateway",
    "baseUrl": base_url,
    # 🔴 只存**变量名**,绝不存值(provider-profile.ts 的契约:requireApiKey 运行时读 env)
    "apiKeyEnv": "LLM_API_KEY",
    "api": "openai-completions",
    "roles": {
        "main": {
            "provider": provider,
            "modelId": model_id,
            "contextWindow": context_window,
            "maxTokens": max_tokens,
            "reasoning": reasoning,
            # 内网网关不计费 ⇒ 全 0。后果见 entrypoint.sh 文件头的 ⚠ 段。
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        }
    },
}

out.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for w in warns:
    print(f"  ⚠ {w}", file=sys.stderr)
print(
    f"  id=gateway provider={provider} modelId={model_id} baseUrl={base_url} "
    f"contextWindow={context_window} maxTokens={max_tokens} reasoning={str(reasoning).lower()} cost=0"
)
RENDER_PROFILE_PY
then
  die "gateway.json 渲染失败(详情见上方原始输出)" profile-render-failed
fi

# 🔴 TASK_RUNTIME_PROFILE 是 serve 真正会去读的路径。它由镜像 ENV 给成
#    /data/config/gateway.json,但 compose 的 env_file **优先级高于镜像 ENV** ——
#    deploy/.env 里若登记了别的值,就会静默地让本次渲染白做。
#    不匹配时说清楚,不静默:目标文件不存在直接 die(否则 serve 会以一条 ENOENT
#    收场,现场看不出根因),存在则 WARN(操作员可能有意自带一份 profile)。
if [ "$TASK_RUNTIME_PROFILE" != "$GATEWAY_JSON" ]; then
  if [ -f "$TASK_RUNTIME_PROFILE" ]; then
    log_warn "TASK_RUNTIME_PROFILE=${TASK_RUNTIME_PROFILE} 指向的不是本脚本渲染的 ${GATEWAY_JSON} —— serve 会用那份自带的 profile,本次 LLM_BASE_URL / LLM_MODEL / LLM_CONTEXT_WINDOW 的渲染结果对本次启动不生效"
  else
    die "TASK_RUNTIME_PROFILE=${TASK_RUNTIME_PROFILE},但该文件不存在;本脚本只渲染 ${GATEWAY_JSON}。修法:把 deploy/.env 里的 TASK_RUNTIME_PROFILE 删掉(镜像 ENV 已经是正确的 ${GATEWAY_JSON}),或改成这个值" profile-path-mismatch
  fi
fi

# ── 5/5 exec serve ────────────────────────────────────────────────────────
# 🔴 入口是 cli/main.ts serve,**不是** cli/serve.ts,也不能用 `run --spec` 代替:
#    cli/main.ts 的 run 分支给 createMcpToolset 传的 scope 是字面 null
#    (源码注释写明"eval / CLI 不是权限场景"),C1 会拒掉每一次工具调用。
# exec 而不是普通调用:让 node 直接接管 PID 1,SIGTERM 才能到达 serveMain 注册的
# 信号处理(否则 docker stop 只能等超时后 SIGKILL)。
log_info "5/5 exec serve(port=${TASK_RUNTIME_PORT}, specs=${TASK_RUNTIME_SPECS_DIR}, workRoot=${TASK_RUNTIME_WORK_ROOT})"
exec node --experimental-strip-types "$SERVE_ENTRY" serve
