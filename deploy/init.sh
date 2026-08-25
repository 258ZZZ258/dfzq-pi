#!/usr/bin/env bash
# init.sh —— 建库三段,在 pi 容器内跑:
#     docker-compose run --rm --entrypoint /app/deploy/init.sh pi
#
#   段 1  alembic upgrade head(cwd=/opt/audit-ai)
#   段 2  seed 字典表(dict_biz_domains / dict_entity_types / dict_aliases)
#   段 3  Milvus audit_corpus collection —— 形态校验 → 复用+load / 建立
#
# 规格:dfzq-pi开发任务/骨架/规格-容器化与一键部署.md §4。
# 逻辑搬自 ~/dfzq-predeploy/scripts/45-init-db.sh(宿主版),三段各自独立幂等。
# 日志只走 stdout/stderr(容器的日志出口是 docker logs);🔴 不 source predeploy 的
# scripts/lib.sh —— 容器里没有那个仓,log/die 在本文件内自带最小实现。
#
# ══ 继承 45-init-db.sh 文件头记录的四条"照 brief 写会错、实测才发现"的修正 ══
#
#  1) 🔴 段 1 的判据**不是**解析 `alembic current` 的文本。
#     45-init-db.sh 实测证伪:<audit-ai>/alembic.ini 的 [logger_alembic] level=INFO、
#     handlers 为空(冒泡到 root 的 console handler),而 [handler_console] 是
#     `args = (sys.stderr,)`;更关键的是 alembic 自己的 MigrationContext.__init__
#     在**构造迁移上下文**这一步就无条件打两行 INFO("Context impl %s." /
#     "Will assume %s DDL."),发生在查 alembic_version 表之前、与到底有没有落地过
#     任何 revision 完全无关 ⇒ `alembic current 2>&1` 恒非空,"输出非空即在 head"
#     这条判据形同虚设。
#     本脚本改问"数据库确实在 head":用 alembic 自己的 ScriptDirectory.get_heads()
#     (本地迁移脚本算出的 head)与 alembic_version 表里真实落地的 revision **逐字比对**。
#     且不用 `2>&1` 把日志混进要解析的数据流 —— 数据只从 stdout 取一行 JSON,
#     stderr 留给失败时的 traceback,原样直通终端。
#
#  2) 🔴 段 3 的 `.load()` 是 pymilvus **Collection 对象**自己的方法。
#     **MilvusIO 没有 load() 方法** —— 已再次逐个核对
#     pipeline/pipeline/index/milvus_io.py 的全部方法:__init__ / connect /
#     disconnect / schema / create_collection / describe / partition_key_field /
#     _collection / upsert / flush / count / delete / probe_retrieval_mode / search,
#     没有一个叫 load。唯一存在的 `.load()` 调用是 create_collection() 内部对**新建**的
#     collection 调 col.load()(该方法末尾)。照抄伪代码写 `mio.load()` 会直接
#     AttributeError —— 45-init-db.sh 第一轮真跑排练栈时就是这么炸的。
#     ⇒ 复用分支在自己拿到的 `Collection(name)` 对象上 col.load();
#       新建分支**不再重复 load**(create_collection() 内部已经做过)。
#
#  3) 🔴 PIPELINE_MILVUS_PORT 是个**不会生效**的环境变量。
#     pipeline/pipeline/config.py::_apply_env(全仓唯一处理 env 覆盖的函数)只处理
#     PIPELINE_DB_DSN → db.dsn、PIPELINE_MILVUS_HOST → milvus.host,以及
#     PIPELINE_EMBEDDING_* / PIPELINE_SPARSE_BACKEND → embedding.*;**没有任何一行**
#     处理 milvus.port(全仓 grep 在 audit-ai 零命中)。而 MilvusIO.connect() 用的是
#     self.cfg.port(= settings.milvus.port),唯一来源是 settings.toml。
#     ⇒ 传了 PIPELINE_MILVUS_PORT=19531 而 settings.toml 写的是 19530 时,脚本会
#       安静地连到 19530。处置:仍然 require 它(值有校验价值),但在**连接 Milvus
#       之前**显式比对 load_config() 解出的 cfg.milvus.port 与 $PIPELINE_MILVUS_PORT,
#       不一致就 die(anchor milvus-port-mismatch),把静默陷阱变成响亮报错。
#
#  4) 🔴 段 1 的 `alembic upgrade head` 不能是裸调用。它的真实失败面比"PG 连不上"宽
#     (45-init-db.sh 实测三种,输出通道与退出码都不同:未捕获的
#     OperationalError / DuplicateColumn 走 stderr+RC=1;多 head 分叉被 alembic 自己
#     捕获成 CommandError,经 util/messaging.py::err() 打到 **stdout**、RC=255)。
#     不枚举失败原因,只问"这条命令必须成功":用 `if ! (...); then die ...; fi` 包一层,
#     不捕获任何输出(子进程原始输出照常直通终端),die 只追加一行文档指针。
#
# ══ 容器版相对宿主版的三处刻意差异 ══
#
#  A) 🔴 seeds 目录**显式**取 ${DFZQ_AUDIT_AI_ROOT}/seeds,不用
#     `cfg.config_dir.parent / "seeds"`(pipeline/pipeline/cli.py:83 的 up() 是那么写的)。
#     原因:entrypoint.sh 把 PIPELINE_CONFIG_DIR 改成了 /data/config ⇒
#     config_dir.parent 会算成 /data,而 /data/seeds **不存在**(seeds 在镜像的
#     /opt/audit-ai/seeds)。照抄 cli.py 那行会得到一个 FileNotFoundError,
#     或者更糟 —— 将来 /data 下恰好有个空的 seeds 目录时静默 seed 出 0 行。
#
#  B) 路径/解释器来自镜像 ENV:DFZQ_AUDIT_AI_ROOT=/opt/audit-ai、
#     DFZQ_AUDIT_AI_PYTHON=/opt/venv/bin/python(Dockerfile.base 固化),
#     不再有 DFZQ_SRC_ROOT / .venv 那套宿主假设。
#
#  C) ⚠ 本脚本经 `--entrypoint` 启动,**绕过了 entrypoint.sh**,所以 PIPELINE_CONFIG_DIR
#     是镜像 ENV 的 /opt/audit-ai/config(那份没渲染过的原稿),不是 entrypoint.sh 渲染出的
#     /data/config。这不影响正确性,因为本脚本真正依赖的三项里:
#         db.dsn        ← PIPELINE_DB_DSN      env 覆盖生效
#         milvus.host   ← PIPELINE_MILVUS_HOST env 覆盖生效
#         sparse_backend ← PIPELINE_SPARSE_BACKEND env 覆盖生效
#     只有 milvus.port 没有 env 通道 —— 那正是上面第 3 条那道 port_mismatch 守卫存在的理由。
#     下面会把实际用到的 settings.toml 路径与解出的关键值都打进日志,便于现场对账。
#
# 段 2 的实际行为(照 pipeline/pipeline/index/pg_io.py 的 seed_dicts 文档字符串):
#   只 seed **三张**保留字典表(dict_biz_domains / dict_entity_types / dict_aliases);
#   dict_issuers / dict_departments / dict_violation_types **已裁**;
#   <audit-ai>/seeds/ 下还躺着第四份 dict_scenario_terms.csv,seed_dicts() 根本不读它。
#   ⇒ 本脚本不断言"四张字典",只如实打印 seed_dicts() 返回的 counts 与三张表的真实行数。
#
# 用法:
#   init.sh              真跑
#   init.sh --dry-run    只打印三段计划,不连任何数据库
#
# ANCHORS: unexpected-args missing-env no-audit-dir no-venv no-alembic-ini no-settings-toml no-seeds-dir alembic-upgrade-failed alembic-io-error alembic-not-at-head seed-failed seed-empty milvus-port-mismatch milvus-schema-mismatch milvus-io-error
set -euo pipefail

# ── 最小日志实现(对齐 predeploy scripts/lib.sh 的 log_info/log_warn/die)──────
_redact() {
  printf '%s' "$1" | sed -E 's#([a-zA-Z][a-zA-Z0-9+.-]*://[^/@[:space:]]*):[^/@[:space:]]*@#\1:***@#g'
}
_log_line() {
  local level="$1" msg
  msg="$(_redact "$2")"
  printf '[%s] [%s] [init] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$msg"
}
log_info() { _log_line INFO "$1"; }
log_warn() { _log_line WARN "$1" >&2; }
log_err()  { _log_line ERR  "$1" >&2; }

die() {
  local msg="$1" anchor="${2:-}"
  if [ -n "$anchor" ]; then
    msg="${msg} → 见 deploy/ops/README.md#${anchor}"
  fi
  log_err "$msg"
  exit 1
}

# 空串与未设置同等对待(同 entrypoint.sh / serve.ts 的口径)。
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

# ── 参数 ──────────────────────────────────────────────────────────────────
DRY_RUN=0
_unknown=()
for _arg in "$@"; do
  case "$_arg" in
    --dry-run) DRY_RUN=1 ;;
    *) _unknown+=("$_arg") ;;
  esac
done
if [ "${#_unknown[@]}" -gt 0 ]; then
  die "未知参数:${_unknown[*]}(本脚本只接受 --dry-run)" unexpected-args
fi

require_env PIPELINE_DB_DSN PIPELINE_MILVUS_HOST PIPELINE_MILVUS_PORT

AUDIT_DIR="${DFZQ_AUDIT_AI_ROOT:-/opt/audit-ai}"
VENV_PY="${DFZQ_AUDIT_AI_PYTHON:-/opt/venv/bin/python}"
SEEDS_DIR="${AUDIT_DIR}/seeds"                      # 差异 A:显式取,不用 config_dir.parent
CONFIG_DIR="${PIPELINE_CONFIG_DIR:-${AUDIT_DIR}/config}"

# --dry-run 只预演三段,不校验源码/venv 是否就位 —— 这条判断顺序与上面的 require_env
# 一起构成"配置本身缺失,dry-run 也该照样暴露;镜像布局这类环境细节 dry-run 不关心"
# 的语义(与 45-init-db.sh 同款)。
if [ "$DRY_RUN" = "1" ]; then
  log_info "[dry-run] 预演三段建库动作(cwd=${AUDIT_DIR}),不会真的执行、不会连接任何数据库:"
  log_info "[dry-run]   段 1/3:alembic upgrade head,随后用 ScriptDirectory.get_heads() 与 alembic_version 表逐字比对"
  log_info "[dry-run]   段 2/3:seed 字典表(seed_dicts,seeds=${SEEDS_DIR},merge upsert,重跑不产生重复行)"
  log_info "[dry-run]   段 3/3:milvus collection 形态校验/建立 + load(host=${PIPELINE_MILVUS_HOST} port=${PIPELINE_MILVUS_PORT})"
  log_info "[dry-run]   配置来源:${CONFIG_DIR}/settings.toml"
  exit 0
fi

[ -d "$AUDIT_DIR" ] || die "缺 ${AUDIT_DIR} —— 镜像里没有 audit-ai 源码?底座镜像的 COPY 层缺了" no-audit-dir
[ -x "$VENV_PY" ] || die "缺 ${VENV_PY} —— 镜像里没有 /opt/venv?底座镜像的 pip install 层缺了" no-venv
[ -f "${AUDIT_DIR}/alembic.ini" ] || die "缺 ${AUDIT_DIR}/alembic.ini" no-alembic-ini
[ -f "${CONFIG_DIR}/settings.toml" ] || die "缺 ${CONFIG_DIR}/settings.toml(PIPELINE_CONFIG_DIR=${PIPELINE_CONFIG_DIR:-<未设置,回落 ${AUDIT_DIR}/config>})" no-settings-toml
[ -d "$SEEDS_DIR" ] || die "缺 ${SEEDS_DIR} —— 段 2 的字典 CSV 在这里,底座镜像的 COPY audit-ai/seeds/ 层缺了" no-seeds-dir

log_info "配置来源:${CONFIG_DIR}/settings.toml;解释器:${VENV_PY};seeds:${SEEDS_DIR}"

# _jget JSON KEY —— 打印标量字段(取不到印空串,绝不非零退出)。
_jget() {
  "$VENV_PY" -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    v = d.get(sys.argv[2])
    print("" if v is None else v)
except Exception:
    print("")
' "$1" "$2"
}

# _jget_csv JSON KEY —— 打印列表字段,逗号拼接(_jget 直接 print 一个 list 会印成
# "['a', 'b']" 这种 repr,不是给人看的诊断文案该有的样子)。
_jget_csv() {
  "$VENV_PY" -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    v = d.get(sys.argv[2]) or []
    print(",".join(str(x) for x in v))
except Exception:
    print("")
' "$1" "$2"
}

# ── 段 1/3:alembic upgrade head ───────────────────────────────────────────
log_info "段 1/3 开始:alembic upgrade head(cwd=${AUDIT_DIR})…"
# 见文件头修正 4:不捕获输出,只问"这条命令必须成功"。
if ! (cd "$AUDIT_DIR" && "$VENV_PY" -m alembic upgrade head); then
  die "alembic upgrade head 执行失败(完整输出见上方,未被捕获/未被吞掉)——常见成因:连不上 PG(检查 PIPELINE_DB_DSN 与 pg 容器是否 healthy)、迁移历史与实际库结构冲突(revision 已推进但对应 DDL 未真正生效)、本地迁移脚本出现多个 head 分叉" alembic-upgrade-failed
fi

# 见文件头修正 1:判据是"数据库确实在 head",不是"alembic current 有没有输出"。
alembic_state="$(cd "$AUDIT_DIR" && "$VENV_PY" - <<'ALEMBICPY'
import json
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError
from pipeline.config import load_config


def main():
    cfg = load_config()
    alcfg = Config("alembic.ini")
    script = ScriptDirectory.from_config(alcfg)
    heads = sorted(script.get_heads())

    engine = create_engine(cfg.db.dsn)
    try:
        with engine.connect() as conn:
            try:
                rows = conn.execute(text("SELECT version_num FROM alembic_version")).fetchall()
                current = sorted(r[0] for r in rows)
            except ProgrammingError:
                current = []  # alembic_version 表不存在 = 数据库从未跑过迁移
    finally:
        engine.dispose()

    return {"ok": 1, "heads": heads, "current": current, "at_head": current == heads}


try:
    out = main()
except Exception as e:
    out = {"ok": 0, "reason": "unexpected", "err": f"{type(e).__name__}: {e}"}
print(json.dumps(out))
ALEMBICPY
)"

alembic_ok="$(_jget "$alembic_state" ok)"
if [ "$alembic_ok" != "1" ]; then
  alembic_err="$(_jget "$alembic_state" err)"
  die "段 1:alembic 迁移状态校验失败:${alembic_err:-未知原因}" alembic-io-error
fi
at_head="$(_jget "$alembic_state" at_head)"
if [ "$at_head" != "True" ]; then
  heads_csv="$(_jget_csv "$alembic_state" heads)"
  current_csv="$(_jget_csv "$alembic_state" current)"
  die "段 1:alembic upgrade head 执行完毕,但数据库实际落地的 revision(${current_csv:-空})与迁移脚本算出的 head(${heads_csv:-空})不一致——迁移没有真的生效" alembic-not-at-head
fi
current_csv="$(_jget_csv "$alembic_state" current)"
log_info "段 1/3 完成:alembic 已在 head(${current_csv});task_runs 表由 alembic/versions/0017_task_runtime_history.py 建,已被这一段覆盖,不需要独立建表步骤"

# ── 段 2/3:seed 字典表 ────────────────────────────────────────────────────
log_info "段 2/3 开始:seed 字典表(seeds=${SEEDS_DIR})…"
# 判据是**表里的真实行数 > 0**,不是 seed_dicts() 返回的"读了几行 CSV"
# (后者哪怕一行都没写进库也会是个正数)。同时打印 seed 前/后的行数:
# 重跑时两者相等,就是"merge upsert、不产生重复行"这条幂等承诺的现场凭证。
if ! seed_out="$(cd "$AUDIT_DIR" && "$VENV_PY" - "$SEEDS_DIR" <<'SEEDPY'
import json, sys
from sqlalchemy import text
from pipeline.config import load_config
from pipeline.index.pg_io import PgIO

# seed_dicts() 只写这三张(dict_issuers / dict_departments / dict_violation_types 已裁,
# seeds/dict_scenario_terms.csv 也不在它的读取范围内)——以 pg_io.py 的实现为准。
TABLES = ("dict_biz_domains", "dict_entity_types", "dict_aliases")


def counts(pio):
    out = {}
    with pio.engine.connect() as conn:
        for t in TABLES:
            out[t] = conn.execute(text(f"SELECT count(*) FROM {t}")).scalar()
    return out


def main():
    seeds_dir = sys.argv[1]
    cfg = load_config()
    pio = PgIO.from_config(cfg)
    try:
        before = counts(pio)
        imported = pio.seed_dicts(seeds_dir)
        after = counts(pio)
    finally:
        pio.engine.dispose()
    empty = [t for t, n in after.items() if not n]
    return {
        "ok": 0 if empty else 1,
        "reason": "empty_tables" if empty else "",
        "empty": empty,
        "imported": imported,
        "before": before,
        "after": after,
    }


try:
    out = main()
except Exception as e:
    out = {"ok": 0, "reason": "unexpected", "err": f"{type(e).__name__}: {e}"}
print(json.dumps(out))
SEEDPY
)"; then
  die "段 2:seed 字典表的子进程异常退出(完整输出见上方)" seed-failed
fi

seed_ok="$(_jget "$seed_out" ok)"
if [ "$seed_ok" != "1" ]; then
  seed_reason="$(_jget "$seed_out" reason)"
  case "$seed_reason" in
    empty_tables)
      die "段 2:seed 之后字典表仍然是 0 行(${seed_out})——检查 ${SEEDS_DIR} 下的 CSV 是不是空的,或 seed_dicts() 写进了另一个库" seed-empty
      ;;
    *)
      seed_err="$(_jget "$seed_out" err)"
      die "段 2:seed 字典表失败:${seed_err:-未知原因}" seed-failed
      ;;
  esac
fi
log_info "段 2/3 完成:字典已 seed(merge upsert,重跑不产生重复行)。明细(CSV 读入行数 / seed 前后表行数):${seed_out}"

# ── 段 3/3:Milvus collection ──────────────────────────────────────────────
#
# 先校验形态再建,不是无脑调 create_collection():已存在的 collection 若形态
# (dense_vec 维度 / corpus_type 是不是 partition key / text 字段的稀疏通道形态)
# 与当前 sparse_backend 不一致,是"配置定稿前建错了"的静默错误,必须响亮拒绝 ——
# 既不能默默复用一个形态不对的 collection,也不能未经确认就地 drop 重建
# (那会清空该 collection 的全部已入库向量)。
# 🔴 collection **建好就不再重建**(MilvusIO.create_collection() 已存在即复用),
#    所以 sparse_backend 必须在跑这一段之前定稿。
#
# port_mismatch 检查(文件头修正 3)必须在 mio.connect() **之前**做 —— 连都不去连
# 一个"操作员没意识到会被忽略"的端口,比连接失败后才发现更能说清问题出在哪。
log_info "段 3/3 开始:milvus collection 形态校验/建立 + load(host=${PIPELINE_MILVUS_HOST} port=${PIPELINE_MILVUS_PORT})…"
milvus_out="$(cd "$AUDIT_DIR" && "$VENV_PY" - "$PIPELINE_MILVUS_PORT" <<'MILVUSPY'
import json, sys
from pymilvus import Collection, utility
from pipeline.config import load_config
from pipeline.index.milvus_io import MilvusIO

# libs/common/common/milvus_schema.py 的 DENSE_DIM(BAAI/bge-m3,由模型决定,非可调)
DENSE_DIM = 1024


def main():
    env_port = sys.argv[1]
    cfg = load_config()
    if str(cfg.milvus.port) != str(env_port):
        return {
            "ok": 0, "reason": "port_mismatch",
            "cfg_port": cfg.milvus.port, "env_port": env_port,
            "config_dir": str(cfg.config_dir),
        }

    mio = MilvusIO(cfg)
    mio.connect()
    try:
        # bm25:text 开 analyzer + 挂 Function(BM25),sparse_vec 由 Milvus 侧产;
        # bge/none:text 无 analyzer,sparse_vec 由客户端写。
        # (libs/common/common/milvus_schema.py::audit_corpus_schema)
        want_bm25 = cfg.embedding.sparse_backend == "bm25"
        name = cfg.milvus.collection
        if utility.has_collection(name):
            col = Collection(name)
            fields = {f.name: f for f in col.schema.fields}
            dim = fields["dense_vec"].params.get("dim")
            is_pk = bool(getattr(fields["corpus_type"], "is_partition_key", False))
            has_analyzer = bool(fields["text"].params.get("enable_analyzer"))
            if dim != DENSE_DIM:
                return {"ok": 0, "reason": "dim_mismatch", "dim": dim,
                        "sparse_backend": cfg.embedding.sparse_backend}
            if not is_pk:
                return {"ok": 0, "reason": "not_partition_key",
                        "sparse_backend": cfg.embedding.sparse_backend}
            if has_analyzer != want_bm25:
                return {
                    "ok": 0, "reason": "sparse_backend_mismatch",
                    "has_analyzer": int(has_analyzer), "want_bm25": int(want_bm25),
                    "sparse_backend": cfg.embedding.sparse_backend,
                }
            # 🔴 不 load 检索会失败。复用分支要在**已经拿到的 col 对象**上显式 load():
            #    MilvusIO 没有 load() 方法(文件头修正 2),`mio.load()` 是 AttributeError。
            col.load()
            action = "reused"
        else:
            mio.create_collection()  # 内部已对新建的 collection 调过 col.load(),不重复
            action = "created"
        return {
            "ok": 1, "action": action, "collection": name,
            "sparse_backend": cfg.embedding.sparse_backend,
            "config_dir": str(cfg.config_dir),
        }
    finally:
        mio.disconnect()


try:
    out = main()
except Exception as e:
    out = {"ok": 0, "reason": "unexpected", "err": f"{type(e).__name__}: {e}"}
print(json.dumps(out))
MILVUSPY
)"

ok="$(_jget "$milvus_out" ok)"
if [ "$ok" != "1" ]; then
  reason="$(_jget "$milvus_out" reason)"
  case "$reason" in
    port_mismatch)
      cfg_port="$(_jget "$milvus_out" cfg_port)"
      cfg_dir="$(_jget "$milvus_out" config_dir)"
      die "段 3:PIPELINE_MILVUS_PORT=${PIPELINE_MILVUS_PORT} 与 ${cfg_dir:-$CONFIG_DIR}/settings.toml 的 [milvus].port=${cfg_port} 不一致 —— pipeline.config._apply_env **不支持**用环境变量覆盖 milvus.port(只支持 PIPELINE_MILVUS_HOST 覆盖 host),这个环境变量本身不会改变实际连接端口。必须让两者一致:容器网络内固定用 19530(compose.yml 的 pi.environment 已经这么设),若这里读到别的值,是 deploy/.env 的 PIPELINE_MILVUS_PORT 被改过" milvus-port-mismatch
      ;;
    dim_mismatch|not_partition_key|sparse_backend_mismatch)
      has_analyzer="$(_jget "$milvus_out" has_analyzer)"
      dim="$(_jget "$milvus_out" dim)"
      sparse_backend="$(_jget "$milvus_out" sparse_backend)"
      die "段 3:既有 collection 的形态与当前配置不符(reason=${reason}, dense_vec.dim=${dim:-?}, text.enable_analyzer=${has_analyzer:-?}, sparse_backend=${sparse_backend:-?})—— 拒绝静默复用一个形态不对的 collection。修法需人显式确认:drop 重建会**清空该 collection 的全部向量、语料要全量重灌**(MilvusIO(cfg).create_collection(drop_existing=True)),本脚本不会自动做" milvus-schema-mismatch
      ;;
    *)
      err="$(_jget "$milvus_out" err)"
      die "段 3:Milvus 建库/校验失败:${err:-未知原因}" milvus-io-error
      ;;
  esac
fi

action="$(_jget "$milvus_out" action)"
collection_name="$(_jget "$milvus_out" collection)"
sparse_backend="$(_jget "$milvus_out" sparse_backend)"
case "$action" in
  reused)  log_info "段 3/3 完成:collection ${collection_name} 已存在且形态与 sparse_backend=${sparse_backend} 一致,已 load" ;;
  created) log_info "段 3/3 完成:collection ${collection_name} 不存在,已按 sparse_backend=${sparse_backend} 建立并 load" ;;
  *)       log_info "段 3/3 完成:collection ${collection_name} 已就绪(action=${action}, sparse_backend=${sparse_backend})" ;;
esac
# 🔴 这一行值得盯:collection 形态由 sparse_backend 决定,而 collection 建好就不再重建。
# 现场实测结论是 bm25(嵌入网关不返 sparse_embedding)。若这里打出来的不是预期值,
# 现在就停下来改 deploy/.env 的 PIPELINE_SPARSE_BACKEND 并 drop 重建,别等灌完全量语料。
log_info "init.sh 完成:alembic 在 head(${current_csv})/ 字典已 seed / collection ${collection_name} 已就绪(sparse_backend=${sparse_backend})"
