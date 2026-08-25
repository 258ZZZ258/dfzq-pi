#!/usr/bin/env bash
# check-compose-keys.sh —— 按 docker-compose **1.29.2** 的 compose_spec.json 校验
# compose 文件的键名(顶层 / 服务级 / 卷级,外加 healthcheck 与 depends_on.<svc> 两层)。
#
# 规格:dfzq-pi开发任务/骨架/规格-容器化与一键部署.md §0.2 的 CI 覆盖缺口 + §6.1 stage 2
#
#   ./check-compose-keys.sh                 检查 deploy/ 下的 compose.yml 与 compose.rehearsal.yml
#   ./check-compose-keys.sh a.yml b.yml     检查指定的若干份文件
#   ./check-compose-keys.sh -h
#
# 退出码:0 = 全部在白名单内;1 = 有白名单外的键(或某份文件抽不到键 / 写成了 flow 风格);
#         2 = 用法/文件错误。
#
# ── 为什么需要这个脚本 ────────────────────────────────────────────────────────
# 生产机是 docker-compose 1.29.2(§0.2),排练栈按 D-10 搬到了 Jenkins 主节点,而主节点
# 大概率是新版 compose。于是"这份 compose 文件在 1.29.2 上能否解析"**不再被排练栈覆盖**
# —— 现场撞过的顶层 `name:` 那类问题在新版上一路绿灯,到生产机才在解析阶段整份文件被拒。
# 这个脚本把那条边界变回可断言的事实。
#
# 🔴 判据是**边界不是清单**:不是"不许写 name",是"只许写 1.29.2 认识的键",
#    任何新键、任何本检查器算不出来的层级,一律默认拒绝。
#
# ⚠ 说清楚边界,不说满:
#   - 它**不是 YAML 解析器**。语法坏掉的 YAML 会被照样放行(真 1.29.2 会拒)。
#   - 它只管**键名**,不校验**取值**(depends_on.<svc>.condition 的合法枚举、
#     healthcheck.test 的形状、端口串的写法……)。值域错误只有真跑一次
#     `docker-compose config -q` 才发现 —— 那是验收 A11 的后半句,不是本脚本能替的。
#   - 只认**块式(缩进式)**映射。文件里出现 flow 风格的 `{ ... }` 映射会被直接判红:
#     抽不进花括号 ≠ 里面没问题(规格 §3.3 的示意写法正是流式,照抄会让那份文件
#     整个不受白名单保护却依然全绿)。
#   - 用 python3 自己按缩进抽键,不引第三方依赖(PyYAML 在目标机上不保证有,而且本脚本
#     要能在只有系统 python3 的构建机上跑)。抽不到键 → CHECKED=0 → 直接判失败,
#     免得"发现机制失效"伪装成"没有违规"。
#
# 🔴 白名单出处:~/dfzq-predeploy/tests/test-stack.sh 的 Part 6
#    (说明第 499–540 行;TOP 第 556 行、SERVICE 第 557–573 行、VOLUME 第 574 行、
#     HEALTHCHECK 第 581 行、DEPENDS_ON_ENTRY 第 582 行、FREEFORM 第 585–586 行;
#     键抽取与判定逻辑第 588–661 行)。那份白名单是从真二进制里抽的:
#      python3 -m pip download docker-compose==1.29.2 --no-deps -d w && unzip w/*.whl
#      → compose/config/compose_spec.json
#      顶层 properties = 6 个,patternProperties = ['^x-'],additionalProperties = False
#      definitions.service:      properties = 79 个,patternProperties = ['^x-'],additionalProperties = False
#      definitions.volume:       properties = 5 个,additionalProperties = False
#      definitions.healthcheck:  properties = 6 个,additionalProperties = False
#      service.properties.depends_on 的对象形态:每个服务名下只有 condition
#    两处白名单**必须逐字保持一致**;改了那边记得改这边(反之亦然)。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_info() { printf '[check-compose-keys] %s\n' "$1"; }
log_err()  { printf '[check-compose-keys] ✗ %s\n' "$1" >&2; }

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}"; }

FILES=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    -*) log_err "未知参数:$arg"; usage >&2; exit 2 ;;
    *) FILES+=("$arg") ;;
  esac
done

# 缺省:deploy/ 下的两份 compose 文件(按脚本自身位置定位,不依赖调用者的 cwd)
if [ "${#FILES[@]}" -eq 0 ]; then
  FILES=("$HERE/compose.yml" "$HERE/compose.rehearsal.yml")
fi

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { log_err "文件不存在:$f"; exit 2; }
done

command -v python3 >/dev/null 2>&1 || { log_err "需要 python3"; exit 2; }

log_info "按 docker-compose 1.29.2 的键白名单检查 ${#FILES[@]} 份文件"

rc=0
# 🔴 bash 3.2 在 set -u 下展开空数组会报 unbound variable;上面已保证非空,这里仍按
#    全仓约定用安全习惯用法展开(见 dfzq-predeploy/scripts/lib.sh 顶部那段)。
python3 - ${FILES[@]+"${FILES[@]}"} <<'PYEOF' || rc=$?
"""按 docker-compose 1.29.2 的 compose_spec.json 校验若干份 compose 文件的键名。

逐字搬自 ~/dfzq-predeploy/tests/test-stack.sh Part 6 的 V1KEYS 校验器
(白名单第 556–586 行、逻辑第 588–661 行),改动三处:
  1. 接受多个文件参数,报错行首带上是哪份文件;
  2. CHECKED == 0 判失败(那边由调用方的 assert 兜着,这里没有 assert 兜);
  3. 增加 flow 风格映射的探测 —— 见 flow_mappings() 的注释,同样是"算不出来就判红"。
"""
import re
import sys

# ---- 白名单(出自 1.29.2 的 compose/config/compose_spec.json)----------------
TOP = {"version", "services", "networks", "volumes", "secrets", "configs"}
SERVICE = {
    "blkio_config", "build", "cap_add", "cap_drop", "cgroup_parent", "command",
    "configs", "container_name", "cpu_count", "cpu_percent", "cpu_period",
    "cpu_quota", "cpu_rt_period", "cpu_rt_runtime", "cpu_shares", "cpus",
    "cpuset", "credential_spec", "depends_on", "deploy", "device_cgroup_rules",
    "devices", "dns", "dns_opt", "dns_search", "domainname", "entrypoint",
    "env_file", "environment", "expose", "extends", "external_links",
    "extra_hosts", "group_add", "healthcheck", "hostname", "image", "init",
    "ipc", "isolation", "labels", "links", "logging", "mac_address",
    "mem_limit", "mem_reservation", "mem_swappiness", "memswap_limit",
    "network_mode", "networks", "oom_kill_disable", "oom_score_adj", "pid",
    "pids_limit", "platform", "ports", "privileged", "profiles", "pull_policy",
    "read_only", "restart", "runtime", "scale", "secrets", "security_opt",
    "shm_size", "stdin_open", "stop_grace_period", "stop_signal", "storage_opt",
    "sysctls", "tmpfs", "tty", "ulimits", "user", "userns_mode", "volumes",
    "volumes_from", "working_dir",
}
VOLUME = {"driver", "driver_opts", "external", "labels", "name"}
# 🔴 第四/第五层。`healthcheck.start_interval` 这类 **v2-only 的第四层键**,真 schema 报错、
# 而只查三层的检查器会放行 —— 与顶层 name: 逐字同一个失败场景(开发机能过、目标机在解析
# 阶段被拒、我们的防线看不见)。下面两个集合同样出自 1.29.2 的 compose_spec.json:
# definitions.healthcheck(additionalProperties:false,6 个 properties)与
# service.properties.depends_on 的对象形态(patternProperties `^[a-zA-Z0-9._-]+$`
# → additionalProperties:false,只有 condition)。
HEALTHCHECK = {"disable", "interval", "retries", "start_period", "test", "timeout"}
DEPENDS_ON_ENTRY = {"condition"}
# 自由映射:这些键下面的子键是**用户自定义名字**(环境变量名、标签名……),不是 schema 键,
# 不能拿任何白名单去卡。
FREEFORM = {"environment", "labels", "sysctls", "storage_opt", "extra_hosts",
            "driver_opts", "options"}

KEY_RE = re.compile(r"^(\s*)([A-Za-z_][A-Za-z0-9_.-]*):(\s|$)")
# ${VAR}/${VAR-默认}/${VAR:?错误} 这类变量替换自带花括号,但不是 flow 映射,先剔掉再判。
SUBST_RE = re.compile(r"\$\{[^}]*\}")


def flow_mappings(text):
    """找出 flow 风格的映射(`pg: { ports: [...] }`)—— 本检查器抽不到它里面的键。

    🔴 纪律一的同一条:抽不到 ≠ 没问题。规格 §3.3 的示意写法正是流式,照抄过去会让
    那份文件**整个不受键白名单保护**却依然全绿。这里显式判红,逼作者改块式。
    ⚠ 已知边界:行内注释里出现 `{` 会误报 —— 别在 compose 文件的行内注释里写花括号。
    """
    for lineno, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if "{" in SUBST_RE.sub("", s):
            yield lineno, s


def paths(text):
    """按缩进抽取块式映射的键路径。`- ` 序列项、续行、flow 集合内部一律不算键。"""
    stack = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = KEY_RE.match(raw)
        if not m:
            continue
        indent, key = len(m.group(1)), m.group(2)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        yield [k for _, k in stack] + [key]
        stack.append((indent, key))


def check(path_to_file):
    """返回 (被判定过的键个数, 违规文案列表)。"""
    with open(path_to_file, encoding="utf-8") as f:
        text = f.read()
    checked = 0
    violations = []
    for lineno, snippet in flow_mappings(text):
        violations.append(
            "第 %d 行是 flow 风格映射(%s)—— 本检查器按行首缩进抽键,**抽不进花括号里面**,"
            "这一段等于不受白名单保护。改写成块式(缩进式)映射,语义完全一样。"
            % (lineno, snippet)
        )
    for path in paths(text):
        # 自由映射(environment/labels/...)下面是用户自定义名字,不受任何白名单约束
        if any(seg in FREEFORM for seg in path[:-1]):
            continue
        if len(path) == 1:
            allowed, where = TOP, "顶层"
        elif len(path) == 2 and path[0] in ("services", "volumes", "networks", "secrets", "configs"):
            continue  # 服务名/卷名本身,由用户自定
        elif len(path) == 3 and path[0] == "services":
            allowed, where = SERVICE, "服务 %s 下" % path[1]
        elif len(path) == 3 and path[0] == "volumes":
            allowed, where = VOLUME, "卷 %s 下" % path[1]
        elif len(path) == 4 and path[0] == "services" and path[2] == "healthcheck":
            allowed, where = HEALTHCHECK, "服务 %s 的 healthcheck 下" % path[1]
        elif len(path) == 4 and path[0] == "services" and path[2] == "depends_on":
            continue  # depends_on 下一层是被依赖的服务名,用户自定
        elif len(path) == 5 and path[0] == "services" and path[2] == "depends_on":
            allowed, where = DEPENDS_ON_ENTRY, "服务 %s 的 depends_on.%s 下" % (path[1], path[3])
        else:
            # 🔴 纪律一:落到这里 = **这条路径本检查器不知道怎么核**。静默 continue 正是
            # healthcheck.start_interval 这类第四层 v2-only 键能全绿溜过去的原因。
            # 改成显式违规:要么把对应子结构的键集合从真 compose_spec.json 抽出来补进上面,
            # 要么就别在这个位置加键。**不能默默放过。**
            checked += 1
            violations.append(
                "路径 %s 落在本检查器覆盖不到的层级 —— **算不出来**,不是「没问题」。"
                "补法:从 docker-compose 1.29.2 的 compose_spec.json 里把这一层的 "
                "properties 集合抽出来,加进本脚本(以及 dfzq-predeploy/tests/test-stack.sh "
                "Part 6)的白名单" % ".".join(path)
            )
            continue
        checked += 1
        key = path[-1]
        if key in allowed:
            continue
        if where == "顶层" or allowed is SERVICE:
            if key.startswith("x-"):
                continue  # patternProperties: ['^x-']
        violations.append(
            "%s的 '%s' 不是 docker-compose 1.29.2 认识的键 —— "
            "'%s' does not match any of the regexes: '^x-'" % (where, key, key)
        )
    return checked, violations


def main(argv):
    failed = False
    for f in argv:
        checked, violations = check(f)
        for v in violations:
            print("[check-compose-keys] ✗ %s: %s" % (f, v), file=sys.stderr)
        if checked == 0:
            # 抽不到任何键 = 发现机制失效(整份文件写成 flow 风格、或路径给错)。
            # 这种情况下"零违规"毫无意义,直接判失败。
            print("[check-compose-keys] ✗ %s: 一个键都没抽到 —— 发现机制失效,"
                  "不是「没有违规」。检查文件是不是写成了 flow 风格 { }。" % f,
                  file=sys.stderr)
            failed = True
        elif violations:
            print("[check-compose-keys] ✗ %s:%d 处违规(共判定 %d 个键)"
                  % (f, len(violations), checked), file=sys.stderr)
            failed = True
        else:
            print("[check-compose-keys] ✓ %s:%d 个键全部在 1.29.2 白名单内"
                  % (f, checked))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PYEOF

if [ "$rc" -ne 0 ]; then
  log_err "检查未通过,逐条见上面的 ✗。白名单外的键到了生产机(docker-compose 1.29.2)会在"
  log_err "**解析阶段**让整份文件被拒;flow 风格 / 覆盖不到的层级则是本检查器算不出来,"
  log_err "同样按不通过处理。改法见规格 §0.2 / §3.1,或把该层的 properties 集合从真"
  log_err "compose_spec.json 抽出来补进本脚本(以及 test-stack.sh Part 6)的白名单。"
  exit "$rc"
fi

log_info "全部通过"
