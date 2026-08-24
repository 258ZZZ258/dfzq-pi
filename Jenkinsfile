// dfzq-pi 内网 CI —— Jenkins Pipeline
//
// 目标:每次推代码,在**干净环境**里验证「装得上、类型/格式过、测试绿」。
// 刻意**不做**部署 —— 内网部署涉及 systemd、四个容器、alembic 迁移,那是另一个
// 手工触发的 Job,不该跟着每次提交跑。
//
// agent 前置(见 README-内网Git与Jenkins.md §3):
//   · Node >= 22.19.0(engines 要求),路径由 DFZQ_NODE_HOME 指定
//   · 能访问内网 npm 镜像(NPM_REGISTRY),或 agent 上已配好 ~/.npmrc

pipeline {
    agent any

    environment {
        // 手工解包的 Node 不在 PATH 里 —— 现场因此把 systemd unit 写坏过一次。
        // 在 Jenkins 全局环境变量里配 DFZQ_NODE_HOME 可覆盖此默认值。
        DFZQ_NODE_HOME = "${env.DFZQ_NODE_HOME ?: '/root/node-v22.19.0-linux-x64'}"
        PATH = "${env.DFZQ_NODE_HOME ?: '/root/node-v22.19.0-linux-x64'}/bin:${env.PATH}"
    }

    options {
        timeout(time: 30, unit: 'MINUTES')   // 防挂死占着 agent
        timestamps()                          // 日志带时间戳
        disableConcurrentBuilds()             // 同一分支串行,避免 workspace 互踩
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    stages {

        stage('环境自检') {
            steps {
                sh '''
                    set -e
                    echo "node: $(command -v node)"
                    node -v && npm -v
                    node -e 'const m=+process.versions.node.split(".")[0]; if(m<22){console.error("需要 Node >= 22.19.0,当前 "+process.versions.node); process.exit(1)}'
                    # providers/data 在内网分支里是**提交进版本库**的(离线不可重建)
                    test -d packages/ai/src/providers/data || {
                        echo "✗ 缺 packages/ai/src/providers/data —— 检出的不是内网分支?"; exit 1; }
                    echo "providers/data: $(ls packages/ai/src/providers/data | wc -l) 个文件"
                '''
            }
        }

        stage('装依赖') {
            steps {
                // --ignore-scripts:跳过 husky(prepare)与 canvas 的 node-gyp,两者在 CI 里都会失败;
                //                   上游 .github/workflows/ci.yml 用的也是它
                // NPM_REGISTRY 由 Jenkins 全局环境变量提供;没配就用 agent 的 npm 默认源
                sh '''
                    set -e
                    if [ -n "${NPM_REGISTRY:-}" ]; then
                        npm ci --ignore-scripts --registry "$NPM_REGISTRY"
                    else
                        npm ci --ignore-scripts
                    fi
                    # 脚本 exit 0 不等于装上了 —— postgres 是 task-runtime 的运行期依赖,单独确认
                    test -d node_modules/postgres || { echo "✗ postgres 未装上"; exit 1; }
                '''
            }
        }

        stage('格式与类型检查') {
            steps {
                // biome + pinned-deps + ts-imports + shrinkwrap + install-lock + tsgo --noEmit + browser-smoke
                sh 'npm run check'
            }
        }

        stage('测试') {
            steps {
                // 🔴 拆成两条,而不是简单排掉 serve-cli.test.ts 整个文件:
                //    该文件里「serves a real request end to end」会 spawn serve,而
                //    createPostgresRunStore 启动即 `SELECT 1`(store/postgres.ts:68)——
                //    它**真的需要一个活的 PostgreSQL**,CI 里没有,不是测试写错。
                //    但同文件另外两条是「没 token / 空 token 拒绝启动」的安全断言,不能跟着丢。
                //    两条合计 773 passed,与全量跑的通过数一致,零失败。
                //    ⚠ 后续给 CI 挂上 PG(容器/sidecar)之后,应改回整包跑,并删掉这段特例。
                sh '''
                    set -e
                    cd packages/task-runtime
                    npx vitest --run --exclude 'test/serve-cli.test.ts' \
                        --reporter=default --reporter=junit --outputFile=../../.ci/junit-main.xml
                    npx vitest --run test/serve-cli.test.ts -t 'refuses to start' \
                        --reporter=default --reporter=junit --outputFile=../../.ci/junit-serve-cli.xml
                '''
            }
        }
    }

    post {
        always {
            junit allowEmptyResults: false, testResults: '.ci/junit-*.xml'
            archiveArtifacts artifacts: '.ci/junit-*.xml', allowEmptyArchive: true
        }
        failure {
            echo '构建失败 —— 看上面第一个红色 stage;常见成因见 README-内网Git与Jenkins.md §5'
        }
    }
}
