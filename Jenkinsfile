// dfzq-pi 内网 CI —— Jenkins Pipeline(镜像工厂)
//
// 规格:dfzq-pi开发任务/骨架/规格-容器化与一键部署.md §6.1(决策 D-5 / D-10 / D-12)
//
// ── 为什么整份重写(D-10)────────────────────────────────────────────────────
// 旧流水线那四个 stage(连通性 / 同步代码到构建机 / 远端构建 / 取回测试报告)存在的
// **唯一**理由是「Jenkins 主节点没有 Node 22」—— 所以代码要先同步一份到构建机(= 生产机)、
// 再 SSH 过去触发 ci/remote-build.sh。Node 进了 pi 镜像之后这条理由消失:主节点只要
// 有 Docker 就能干全部的活。因此:
//   · SSH 私钥凭证绑定、远端文件同步、远端触发这三样全部退役(A12 的 grep 因此为空)
//   · ci/remote-build.sh 删除 —— 其内容分解进 deploy/Dockerfile:六条 check + tsgo +
//     vitest 进 test 阶段;两条 test -d 自检进 runtime 阶段的构建期断言;
//     Node 版本门槛由底座镜像(node:22-bookworm-slim)固定
//   · bbdc702c / 51958fd5 / d124f7fa 三个 commit 打的补丁全部回退
//   · 🔴 排练栈随之搬到主节点,生产机不再承担 CI 负载
// Jenkins 上的凭证 `dfzq-build-ssh` 与那几个 DFZQ_BUILD_* / DFZQ_NODE_HOME
// 全局变量本轮**不删**(生产机可能另有用途),只是这里不再引用(规格 §7.1)。
//
// ── 前置 ────────────────────────────────────────────────────────────────────
//   主节点需要:Docker(多阶段与 --target 从 17.05 起可用,19.03 够用)、
//               docker-compose(v1 独立二进制或 v2 子命令都行,stage 1 自动探)、
//               已 `docker login jfrog.orientsec.com.cn`
//   主节点**不需要**:Node、文件同步工具、到生产机的 SSH、任何 Git 凭证之外的凭证
//   全局环境变量:
//     DFZQ_BASE_TAG   🔴 必需 —— 底座镜像 tag(由 §6.2 的底座流水线产出并打印)
//     DFZQ_REGISTRY   可选 —— 缺省 jfrog.orientsec.com.cn/dev7-docker-release-local
//     NPM_REGISTRY    可选 —— 内网 npm 源,透传给 deploy/build.sh
//     DFZQ_PLATFORM   可选 —— 交叉构建时显式指定,例 linux/amd64
//
// ── 六个 stage ──────────────────────────────────────────────────────────────
//   1 环境自检      docker / compose / JFrog 登录状态
//   2 compose 静态检查   补规格 §0.2 指出的覆盖缺口(排练栈跑在新版 compose 上,
//                        1.29.2 的顶层键白名单不再被排练覆盖)
//   3 构建 + 单测   build.sh --test(--target test),取回 .ci/junit-*.xml
//   4 构建交付镜像  build.sh,tag = git sha 前 7 位
//   5 排练栈        四个数据层 → healthy → init.sh → pi → 轮询 /healthz
//   6 推镜像        仅当分支 dfzq/intranet 且 1–5 全绿

pipeline {
    agent any

    environment {
        REGISTRY   = "${env.DFZQ_REGISTRY ?: 'jfrog.orientsec.com.cn/dev7-docker-release-local'}"
        BASE_TAG   = "${env.DFZQ_BASE_TAG ?: ''}"
        PLATFORM   = "${env.DFZQ_PLATFORM ?: ''}"

        // 排练栈:固定 project 名 + 固定端口 ⇒ 必须串行(见 options 的
        // disableConcurrentBuilds)。四个端口要与 deploy/compose.rehearsal.yml
        // 里写死的那四条**逐字相同** —— compose 多文件合并时 ports 是**追加**语义,
        // 两边解析出同一条映射才会被去重合成一条;漏设就会把 compose.yml 的缺省端口
        // (5432 / 19530 / 9091 / 18080)也发布到宿主,跟本机常驻的栈抢端口。
        REHEARSAL_PROJECT   = 'dfzq-rehearsal'
        REH_PG_PORT         = '15432'
        REH_MILVUS_PORT     = '29530'
        REH_MILVUS_HEALTH   = '29091'
        REH_PI_PORT         = '28080'
        COMPOSE_FILES       = '-f deploy/compose.yml -f deploy/compose.rehearsal.yml'
    }

    options {
        timeout(time: 60, unit: 'MINUTES')
        timestamps()
        // 排练栈复用固定 project 名与固定端口,必须串行(规格 §6.1)
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    stages {
        stage('1 环境自检') {
            steps {
                sh '''
                    set -eu

                    echo "=== docker ==="
                    docker version

                    echo "=== docker-compose ==="
                    # 生产机是 docker-compose 1.29.2 独立二进制;主节点是另一台机器,
                    # 版本大概率更新(规格 §0.3-3b 待确认)。两种形态都接,探到哪个用哪个,
                    # 并把版本打进日志记账 —— stage 2 那个静态检查存在的理由就是「主节点
                    # 不一定是 1.29.2」,这一行是判断那个缺口有多大的现场证据。
                    mkdir -p .ci
                    # 🔴 上一版流水线的旧 junit 报告可能还躺在 workspace 里(2026-08-26 首跑实测:
                    #    stage 3 被跳过时,post 的 junit 捡到 1 天前的旧文件,报一条
                    #    "Test reports were found but none of them are new" 的糊涂错)。
                    #    在这里清掉:早期 stage 失败时 post 只会说"没有报告",不会说胡话。
                    rm -f .ci/junit-*.xml
                    # 🔴 探测不能只看退出码:Docker 18.06(master 实测就是它)对
                    #    `docker compose version` 这种未知命令**打印整页帮助并退出 0**,
                    #    首跑就是被这个骗过、把 "docker compose" 当可用写了进去,
                    #    到 post 里才炸出 `unknown shorthand flag: 'f'`。
                    #    必须验证输出里真有 "Docker Compose" 字样。
                    if command -v docker-compose >/dev/null 2>&1; then
                        echo "docker-compose" > .ci/compose-cmd
                    elif docker compose version 2>/dev/null | grep -q "Docker Compose"; then
                        echo "docker compose" > .ci/compose-cmd
                    else
                        echo "✗ 主节点既没有 docker-compose 独立二进制,也没有真正可用的 docker compose 子命令"
                        echo "  修法(推荐):从生产机拷 1.29.2 —— 和生产同版本,排练顺带验掉 1.29.2 的解析行为:"
                        echo "    scp root@<生产机>:/usr/local/bin/docker-compose /usr/local/bin/docker-compose"
                        echo "    chmod +x /usr/local/bin/docker-compose && docker-compose version"
                        exit 1
                    fi
                    COMPOSE="$(cat .ci/compose-cmd)"
                    echo "compose 命令:${COMPOSE}"
                    $COMPOSE version

                    echo "=== 底座 tag ==="
                    if [ -z "${BASE_TAG:-}" ]; then
                        echo "✗ DFZQ_BASE_TAG 未设置 —— 薄层镜像的 FROM 需要底座 tag。"
                        echo "  在 Jenkins「系统配置 → 全局属性 → 环境变量」里加 DFZQ_BASE_TAG,"
                        echo "  值取自 §6.2 底座流水线最后打印的那个 tag(形如 20260825-f566bbe)。"
                        exit 1
                    fi
                    echo "BASE_TAG=${BASE_TAG}"
                    echo "REGISTRY=${REGISTRY}"

                    echo "=== JFrog 登录状态 ==="
                    # docker info 不打印第三方 registry 的登录状态(只对 Docker Hub 打
                    # Username),所以真正能查的是凭证有没有存进 docker 的 config.json。
                    # ⚠ 这只证明「存过凭证」,不证明凭证此刻仍有效、registry 此刻可达 ——
                    #   那两件事由 stage 3 真去 pull 底座镜像时验证,不在这里假装验过。
                    docker info 2>/dev/null | sed -n '1,40p' || true
                    REGISTRY_HOST="${REGISTRY%%/*}"
                    DOCKER_CFG="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
                    if [ ! -f "$DOCKER_CFG" ]; then
                        echo "✗ 找不到 ${DOCKER_CFG} —— 主节点从没 docker login 过。"
                        echo "  先在主节点上执行:docker login ${REGISTRY_HOST}"
                        exit 1
                    fi
                    if ! grep -q "$REGISTRY_HOST" "$DOCKER_CFG"; then
                        echo "✗ ${DOCKER_CFG} 里没有 ${REGISTRY_HOST} 的凭证条目。"
                        echo "  先在主节点上执行:docker login ${REGISTRY_HOST}"
                        echo "  若报 x509,需要在 /etc/docker/daemon.json 配 insecure-registries 或装内网 CA(规格 §0.3-2)。"
                        exit 1
                    fi
                    echo "✓ ${REGISTRY_HOST} 的凭证已在 ${DOCKER_CFG} 里"

                    echo "=== 本次构建的版本 ==="
                    # 版本留痕,承旧 ci/remote-build.sh 的 BUILD_INFO 一节:
                    # 构建日志与归档里都能看到这次构建的到底是哪一版。
                    printf 'commit=%s\\nbranch=%s\\nbuild=%s\\nbase_tag=%s\\n' \
                        "${GIT_COMMIT:-unknown}" "${GIT_BRANCH:-unknown}" \
                        "${BUILD_TAG:-unknown}" "${BASE_TAG}" \
                        > .ci/BUILD_INFO
                    cat .ci/BUILD_INFO
                '''
            }
        }

        stage('2 compose 静态检查') {
            steps {
                sh '''
                    set -eu
                    # 🔴 补规格 §0.2 点名的 CI 覆盖缺口:排练栈按 D-10 跑在主节点,主节点若是
                    #    新版 compose,「这份 compose.yml 在 1.29.2 上能不能解析」就**不再被排练
                    #    覆盖** —— 现场撞过的顶层 `name:` 键那类问题在这里不会复现。
                    #    check-compose-keys.sh 按 1.29.2 真二进制 compose_spec.json 抽出的
                    #    顶层/服务级/卷级键白名单校验两份 compose 文件,白名单外的键一律翻红。
                    #    (白名单出处与 ~/dfzq-predeploy/tests/test-stack.sh Part 6 同一份)
                    #
                    # 🔴 在**底座容器里**跑,不在宿主上跑:check-compose-keys.sh 要 python3,
                    #    而 master 没有(RHEL 7.4,2026-08-26 首跑实测翻红)。底座里有
                    #    python3,master 本地就有这个镜像(底座就是从这台机 push 的)——
                    #    这才符合「主节点只要有 Docker 就够」的设计,不给宿主添装机依赖。
                    #    :ro,z —— 只读挂载;z 兼容 SELinux enforcing 的宿主,disabled 时是空操作。
                    IMG="${REGISTRY}/dfzq-pi-base:${BASE_TAG}"
                    docker image inspect "$IMG" >/dev/null 2>&1 || docker pull "$IMG"
                    docker run --rm -v "$PWD":/w:ro,z -w /w --entrypoint bash "$IMG" deploy/check-compose-keys.sh
                '''
            }
        }

        stage('3 构建 + 单测') {
            steps {
                sh '''
                    set -eu
                    # --target test:六条 check + tsgo + vitest 全在容器内跑(D-12)。
                    # 主节点没有 Node,这些东西**只能**在容器内跑;交付镜像走
                    # --omit=dev 也不含 vitest,所以 test 是独立的一个阶段。
                    # build.sh 跑完会 docker cp 出 /out/junit-*.xml 到 <repo>/.ci/。
                    rm -f .ci/junit-*.xml
                    bash deploy/build.sh --test
                    echo "=== 取回的测试报告 ==="
                    find .ci -name 'junit-*.xml' -print
                    # 报告没取到就该在这里红,而不是等 post 的 junit 步骤才含糊地报「没有测试」
                    test -n "$(find .ci -name 'junit-*.xml' -print -quit)" \
                        || { echo "✗ 没有取到任何 junit 报告 —— test 阶段真的跑到了吗?"; exit 1; }
                '''
            }
        }

        stage('4 构建交付镜像') {
            steps {
                sh '''
                    set -eu
                    # tag = git sha 前 7 位(D-11:不锁 digest,只用不可变 tag)。
                    # build.sh 自己也是这么算的,这里算一遍是为了后面 stage 5/6 拼 PI_IMAGE;
                    # 与 Jenkins 给的 GIT_COMMIT 一并打进日志,两者对不上时一眼看得出来。
                    SHORT_SHA="$(git rev-parse --short=7 HEAD)"
                    echo "GIT_COMMIT=${GIT_COMMIT:-unknown}  →  tag=${SHORT_SHA}"
                    echo "$SHORT_SHA" > .ci/SHORT_SHA
                    bash deploy/build.sh
                    docker image inspect "${REGISTRY}/dfzq-pi:${SHORT_SHA}" \
                        -f '交付镜像 {{.RepoTags}} created={{.Created}}'
                '''
            }
        }

        stage('5 排练栈') {
            steps {
                sh '''
                    set -eu
                    COMPOSE="$(cat .ci/compose-cmd)"
                    SHORT_SHA="$(cat .ci/SHORT_SHA)"

                    # 排练栈与生产栈靠 COMPOSE_PROJECT_NAME 隔离(容器名/卷名自动带前缀),
                    # 端口靠 compose.rehearsal.yml + 下面四个变量隔离。
                    #
                    # 🔴 这些走**导出的环境变量**,不走 deploy/.env,理由有两条:
                    #   1. compose 到底从哪里找 `.env` 做插值,v1(<1.28 看 CWD)与新版
                    #      (看 project directory)规则不一样,而这里的 CWD 是 workspace 根、
                    #      compose 文件在 deploy/ —— 环境变量的优先级在所有版本上都最高,
                    #      不必赌它这次会去哪儿找文件。
                    #   2. 🔴 TASK_RUNTIME_PORT 尤其不能写进 deploy/.env:那份文件同时是 pi
                    #      容器的 env_file(**整份逐行注入容器**),而 compose.yml 里端口映射的
                    #      容器侧与 healthcheck 的 URL 都硬编码 18080。把 28080 注进容器,
                    #      serve 会去听 28080,映射与 healthz 全都对不上、排练必红。
                    #      这里 28080 只该出现在**宿主发布端口**那一侧,即插值这一侧。
                    export COMPOSE_PROJECT_NAME="${REHEARSAL_PROJECT}"
                    export PG_PORT="${REH_PG_PORT}"
                    export MILVUS_PORT="${REH_MILVUS_PORT}"
                    export MILVUS_HEALTH_PORT="${REH_MILVUS_HEALTH}"
                    export TASK_RUNTIME_PORT="${REH_PI_PORT}"
                    export PI_IMAGE="${REGISTRY}/dfzq-pi:${SHORT_SHA}"
                    export PG_PASSWORD="rehearsal"

                    # 上一次构建可能留下残壳(比如构建被中止,post 没跑完)。先清一遍。
                    $COMPOSE $COMPOSE_FILES down -v --remove-orphans || true

                    # ---- 排练用 deploy/.env -------------------------------------------
                    # compose.yml 的 pi service 写的是 env_file: ./.env,文件不在整份
                    # compose 直接解析失败,所以排练栈必须现造一份。它只活在 Jenkins
                    # workspace 里(.env 已被 .gitignore 忽略),不是交付物。
                    #
                    # 🔴 **不设置**三个网关(LLM / 嵌入 / 重排)的地址与 key(D-6):CI 不依赖
                    #    外部服务,排练只跑到「建库 + /healthz 绿」。端到端冒烟留在 predeploy
                    #    的 55-smoke.sh。
                    # ⚠ 但 LLM_API_KEY 要给个占位值 —— entrypoint.sh 对它是 fail-closed 校验
                    #    (provider-profile.ts),而排练不发起任何 run,这个值不会被用到。
                    # 🔴 刻意**不写** TASK_RUNTIME_SPECS_DIR / TASK_RUNTIME_PROFILE /
                    #    TASK_RUNTIME_WORK_ROOT:这三项镜像 ENV 里已经有一套自洽的值,而
                    #    env_file 的优先级**高于**镜像 ENV —— 在这里重复一遍,只会制造
                    #    「.env 抄的那份路径」与「镜像里真实布局」对不上的机会。
                    #    同理这里也不写四个端口变量与 COMPOSE_PROJECT_NAME,见上面的说明。
                    # ⚠ 行尾不要写注释:env_file 的解析**不剥**行尾注释。
                    cat > deploy/.env <<REHEARSAL_ENV
PI_IMAGE=${REGISTRY}/dfzq-pi:${SHORT_SHA}
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
REHEARSAL_ENV
                    chmod 600 deploy/.env

                    # ---- 等 healthy ---------------------------------------------------
                    # 判据直接读 docker inspect 的 State.Health.Status,不解析 compose ps
                    # 的文本(1.29.2 与 v2 的 ps 输出形态不一样,规格 §3.1 的同一条纪律)。
                    wait_healthy() {
                        svc="$1"; budget="$2"
                        deadline=$(( $(date +%s) + budget ))
                        while : ; do
                            cid="$($COMPOSE $COMPOSE_FILES ps -q "$svc" | head -1)"
                            if [ -n "$cid" ]; then
                                st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$cid" 2>/dev/null || echo gone)"
                                [ "$st" = "healthy" ] && { echo "✓ ${svc} healthy"; return 0; }
                            else
                                st="容器还没建出来"
                            fi
                            if [ "$(date +%s)" -ge "$deadline" ]; then
                                echo "✗ ${svc} 在 ${budget}s 内没到 healthy,最后状态:${st}"
                                [ -n "${cid:-}" ] && docker logs --tail 80 "$cid" 2>&1 || true
                                return 1
                            fi
                            sleep 5
                        done
                    }

                    echo "=== 起四个数据层 ==="
                    $COMPOSE $COMPOSE_FILES up -d pg etcd minio milvus
                    # milvus 的 start_period 是 90s,且它 depends_on etcd/minio 都 healthy,
                    # 所以等到 milvus healthy 就等价于四个数据层全绿。
                    wait_healthy pg 300
                    wait_healthy milvus 300

                    echo "=== 建库(init.sh 三段,各自幂等)==="
                    $COMPOSE $COMPOSE_FILES run --rm --entrypoint /app/deploy/init.sh pi

                    echo "=== 起 pi ==="
                    $COMPOSE $COMPOSE_FILES up -d pi
                    PI_CID="$($COMPOSE $COMPOSE_FILES ps -q pi | head -1)"
                    [ -n "$PI_CID" ] || { echo "✗ pi 容器没起来"; exit 1; }

                    echo "=== 轮询 /healthz(超时 120s)==="
                    # 从容器内 curl,不依赖主节点有 curl;镜像里 curl 是 HEALTHCHECK 的
                    # 依赖,一定在。判据用 grep '"ok" : true' 与镜像 HEALTHCHECK 同一口径。
                    deadline=$(( $(date +%s) + 120 ))
                    while : ; do
                        body="$(docker exec "$PI_CID" curl -fsS http://127.0.0.1:18080/healthz 2>/dev/null || true)"
                        if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
                            echo "✓ /healthz 绿:${body}"
                            break
                        fi
                        if [ "$(date +%s)" -ge "$deadline" ]; then
                            echo "✗ /healthz 在 120s 内没绿。最后一次响应体:${body:-<空,连不上>}"
                            docker inspect -f '容器状态 {{.State.Status}} / 健康 {{if .State.Health}}{{.State.Health.Status}}{{else}}无{{end}}' "$PI_CID" || true
                            docker logs --tail 120 "$PI_CID" 2>&1 || true
                            exit 1
                        fi
                        sleep 5
                    done

                    # 顺带确认端口真的发布到了宿主(排练栈的端口映射本身也是被验的对象);
                    # 主节点不一定有 curl,所以这条不作判据,失败只记一行。
                    if command -v curl >/dev/null 2>&1; then
                        curl -fsS --max-time 5 "http://127.0.0.1:${REH_PI_PORT}/healthz" \
                            && echo "  ↑ 宿主 127.0.0.1:${REH_PI_PORT} 上也拿到了" \
                            || echo "  ⚠ 宿主 127.0.0.1:${REH_PI_PORT} 没拿到(端口映射?)—— 不作判据,仅记账"
                    fi

                    echo "=== 排练栈全绿 ==="
                    $COMPOSE $COMPOSE_FILES ps
                '''
            }
        }

        stage('6 推镜像') {
            when {
                // 分支判定两条都收:多分支流水线给 BRANCH_NAME,
                // 单分支「Pipeline script from SCM」只给 GIT_BRANCH(形如 origin/dfzq/intranet)。
                expression {
                    def b = env.BRANCH_NAME ?: env.GIT_BRANCH ?: ''
                    return b == 'dfzq/intranet' || b.endsWith('/dfzq/intranet')
                }
            }
            steps {
                sh '''
                    set -eu
                    SHORT_SHA="$(cat .ci/SHORT_SHA)"
                    # 1–5 全绿才走到这里(任一 stage 红,pipeline 直接停,不会进本 stage)。
                    docker push "${REGISTRY}/dfzq-pi:${SHORT_SHA}"
                    # latest-intranet:给「随便给我一个能跑的最新版」这种场景用(规格 §2.2)。
                    # 🔴 它是**可变** tag,只作便利别名 —— compose 的 PI_IMAGE 一律用 sha tag,
                    #    回滚才有确定的目标(D-11)。
                    docker tag  "${REGISTRY}/dfzq-pi:${SHORT_SHA}" "${REGISTRY}/dfzq-pi:latest-intranet"
                    docker push "${REGISTRY}/dfzq-pi:latest-intranet"
                    echo "✓ 已推:${REGISTRY}/dfzq-pi:${SHORT_SHA}(另打 latest-intranet)"
                '''
            }
        }
    }

    post {
        always {
            // 🔴 顺序要紧:先拆排练栈,再喂 junit。
            //    junit 步骤 allowEmptyResults:false 在没有报告时会抛错并中止 post 块,
            //    清理若排在它后面就会被跳过 —— 残留的排练卷会一直占主节点的磁盘。
            sh '''
                set +e
                COMPOSE="$(cat .ci/compose-cmd 2>/dev/null || echo docker-compose)"
                export COMPOSE_PROJECT_NAME="${REHEARSAL_PROJECT}"
                export PG_PORT="${REH_PG_PORT}"
                export MILVUS_PORT="${REH_MILVUS_PORT}"
                export MILVUS_HEALTH_PORT="${REH_MILVUS_HEALTH}"
                export TASK_RUNTIME_PORT="${REH_PI_PORT}"
                # 构建若在 stage 5 之前就红了,deploy/.env 还不存在,而 compose.yml 里
                # ${PI_IMAGE:?} / ${PG_PASSWORD:?} 是"未设置即拒绝解析" —— 给两个哑值,
                # 让 down 能正常跑完,而不是刷一屏与真实失败无关的插值错误。
                export PI_IMAGE="${PI_IMAGE:-unset/unset:unset}"
                export PG_PASSWORD="${PG_PASSWORD:-unset}"
                # 无论成败都 down -v:排练栈的卷是一次性的(A7),留着只占磁盘。
                # ⚠ 这条 `-v` 只对 COMPOSE_PROJECT_NAME=dfzq-rehearsal 这一套卷生效,
                #   生产栈是 dfzq-policy,天然碰不到。生产栈**永远不许** down -v。
                if [ -f deploy/compose.yml ]; then
                    $COMPOSE -f deploy/compose.yml -f deploy/compose.rehearsal.yml down -v --remove-orphans
                fi
                rm -f deploy/.env
                echo "=== 排练栈残留检查 ==="
                docker volume ls  | grep "${REHEARSAL_PROJECT}" || echo "无残留卷"
                docker ps -a --format '{{.Names}}' | grep "${REHEARSAL_PROJECT}" || echo "无残留容器"
                exit 0
            '''
            archiveArtifacts artifacts: '.ci/junit-*.xml,.ci/BUILD_INFO',
                             allowEmptyArchive: true
            // 「没有测试报告就该是红的」这条纪律由 stage 3 自己守(它跑完当场断言
            // junit-*.xml 真取到了)。post 里的 junit 只在报告存在时喂 —— stage 1/2 就
            // 失败的构建本来就是红的,这里再抛一条 "no report" 只会把真报错挤下屏
            // (2026-08-26 首跑实测:stage 2 红,post 的 junit 又叠了一条 AbortException)。
            script {
                if (fileExists('.ci/junit-main.xml')) {
                    junit allowEmptyResults: false, testResults: '.ci/junit-*.xml'
                } else {
                    echo '无测试报告(stage 3 未运行到)—— 跳过 junit,红因见上面第一个失败的 stage'
                }
            }
        }
        failure {
            echo '''构建失败 —— 看第一个红色 stage:
  1 环境自检      主节点缺 docker-compose(从生产机 scp 1.29.2 过来),或没 docker login JFrog,或 DFZQ_BASE_TAG 没配
  2 compose 静态检查   compose 文件里出现 1.29.2 白名单外的键(典型:顶层 name:);或底座镜像拉不到(检查在底座容器里跑)
  3 构建 + 单测   六条 check / tsgo / vitest 之一没过,或底座镜像拉不到
  4 构建交付镜像  runtime 阶段的两条构建期断言(postgres 装没装上 / providers/data 在不在)
  5 排练栈        数据层没到 healthy、init.sh 三段之一失败、或 /healthz 120s 没绿
  6 推镜像        push 被 registry 拒(凭证过期?仓路径不对?)'''
        }
    }
}
