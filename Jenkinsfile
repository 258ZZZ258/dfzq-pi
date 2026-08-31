// dfzq-pi 内网 CI —— 薄壳:六个 stage 各自只有一句 `bash ci/0X-*.sh`。
//
// 🔴 全部逻辑在 ci/*.sh 里(2026-08-26 应运维要求从 Groovy 拆出):六个脚本可以
//    **脱离 Jenkins 在主节点上按 01→06 手工跑**,效果与这里完全一致。改逻辑改
//    脚本,不碰本文件。各脚本自带注释与失败提示;公共约定见 ci/lib.sh 文件头。
//
// 前置(详见交接文档 §2):
//   · 主节点要有 Docker、docker-compose 1.29.2(从生产机 scp)、已 docker login JFrog
//   · 全局环境变量(三层改造 2026-08-28 后):
//       DFZQ_AUDIT_AI_GIT  内网 Git 的 audit-ai 仓地址 —— stage 0 据此自动定/造底座,
//                          设了它就**不再需要人工维护 DFZQ_BASE_TAG**
//       PIP_INDEX_URL      内网 pypi(Artifactory),stage 0 现造底座时用
//       NPM_REGISTRY       内网 npm 源
//       DFZQ_REGISTRY / DFZQ_PLATFORM / DFZQ_BASE_TAG(过渡期兜底)可选
//   · 主节点**不需要**:Node、python3、rsync、任何 SSH 凭证

pipeline {
    agent any

    environment {
        REGISTRY = "${env.DFZQ_REGISTRY ?: 'jfrog.orientsec.com.cn/dev7-docker-release-local'}"
        BASE_TAG = "${env.DFZQ_BASE_TAG ?: ''}"
        PLATFORM = "${env.DFZQ_PLATFORM ?: ''}"
    }

    options {
        timeout(time: 60, unit: 'MINUTES')
        timestamps()
        // 排练栈用固定 project 名与固定端口(ci/lib.sh),必须串行
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    stages {
        stage('0 底座')            { steps { sh 'bash ci/00-ensure-base.sh' } }
        stage('1 环境自检')        { steps { sh 'bash ci/01-check-env.sh' } }
        stage('2 compose 静态检查') { steps { sh 'bash ci/02-check-compose.sh' } }
        stage('3 构建 + 单测')      { steps { sh 'bash ci/03-build-test.sh' } }
        stage('4 构建交付镜像')     { steps { sh 'bash ci/04-build-image.sh' } }
        stage('5 排练栈')          { steps { sh 'bash ci/05-rehearse.sh' } }
        stage('6 推镜像') {
            when {
                // 两条都收:多分支流水线给 BRANCH_NAME,单分支「Pipeline script from
                // SCM」只给 GIT_BRANCH(形如 origin/dfzq/intranet)。
                // ci/06-push.sh 里还有一道同样的门,那是给手工跑守的。
                expression {
                    def b = env.BRANCH_NAME ?: env.GIT_BRANCH ?: ''
                    return b == 'dfzq/intranet' || b.endsWith('/dfzq/intranet')
                }
            }
            steps { sh 'bash ci/06-push.sh' }
        }
        stage('7 部署到生产') {
            // D-14 全自动 CD:与 stage 6 同一道分支门;暂停用全局变量 DFZQ_NO_PROD_DEPLOY=1。
            // 74 未完成首次容器化切换时,ci/07 响亮跳过而不是红。
            when {
                expression {
                    def b = env.BRANCH_NAME ?: env.GIT_BRANCH ?: ''
                    return b == 'dfzq/intranet' || b.endsWith('/dfzq/intranet')
                }
            }
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'dfzq-build-ssh', keyFileVariable: 'SSH_KEY')]) {
                    sh 'bash ci/07-deploy-prod.sh'
                }
            }
        }
    }

    post {
        always {
            // 🔴 顺序要紧:先拆栈再喂 junit —— junit 抛错会中止 post 块,清理排在
            //    它后面就会被跳过,残留的排练卷一直占主节点磁盘。
            //    05 自己的 trap 正常情况下已拆过,这里是构建被硬中止时的兜底(幂等)。
            sh 'bash ci/05-rehearse.sh --down || true'
            archiveArtifacts artifacts: '.ci/junit-*.xml,.ci/BUILD_INFO',
                             allowEmptyArchive: true
            // 「没有测试报告就该是红的」由 ci/03 自己守(跑完当场断言报告真取到了)。
            // 这里只在报告存在时喂 junit —— stage 1/2 就失败的构建本来就是红的,
            // 再抛一条 "no report" 只会把真报错挤下屏(首跑实测)。
            script {
                if (fileExists('.ci/junit-main.xml')) {
                    junit allowEmptyResults: false, testResults: '.ci/junit-*.xml'
                } else {
                    echo '无测试报告(stage 3 未运行到)—— 跳过 junit,红因见第一个失败的 stage'
                }
            }
        }
        failure {
            echo '''构建失败 —— 看第一个红色 stage(每个脚本的失败提示里带修法):
  0 ci/00-ensure-base.sh    audit-ai 拉不到 / L0(dfzq-runtime-base)不在 / 内网 pip 装不出 venv
  1 ci/01-check-env.sh      缺 docker-compose(从生产机 scp 1.29.2)/ 没 login JFrog
  2 ci/02-check-compose.sh  compose 文件出现 1.29.2 白名单外的键(典型:顶层 name:),或底座镜像拉不到
  3 ci/03-build-test.sh     六条 check / tsgo / vitest 之一没过
  4 ci/04-build-image.sh    runtime 阶段构建期断言(postgres / providers/data)
  5 ci/05-rehearse.sh       数据层没 healthy、init 三段之一失败、或 /healthz 120s 没绿
  6 ci/06-push.sh           push 被 registry 拒(凭证过期?仓路径不对?)
  7 ci/07-deploy-prod.sh    连不上 74(凭证 dfzq-build-ssh?)/ 74 上 deploy.sh 红(看它打印的锚点)'''
        }
    }
}
