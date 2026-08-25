// dfzq-pi 内网 CI —— Jenkins Pipeline
//
// 形态:Jenkins 主节点**不跑构建**(它没有合适版本的 Node),只负责调度;
//      真实构建经 SSH 推到 pi 运行的那台 Linux 上执行(ci/remote-build.sh)。
//      刻意不建独立 agent 节点 —— 现阶段一台构建机够用。
//
// 前置(见 README-内网Git与Jenkins.md §3):
//   凭证:Jenkins 里加一条 "SSH Username with private key",ID 填 dfzq-build-ssh
//   全局环境变量:DFZQ_BUILD_HOST / DFZQ_GIT_URL(必需);
//                DFZQ_NODE_HOME / NPM_REGISTRY / DFZQ_BUILD_DIR(可选)

pipeline {
    agent any

    environment {
        BUILD_HOST = "${env.DFZQ_BUILD_HOST}"
        GIT_REPO   = "${env.DFZQ_GIT_URL}"
        REMOTE_DIR = "${env.DFZQ_BUILD_DIR ?: '/root/ci-workspace/dfzq-pi'}"
        NODE_HOME  = "${env.DFZQ_NODE_HOME ?: '/root/node-v22.19.0-linux-x64'}"
        SSH_OPTS   = "-o StrictHostKeyChecking=no -o BatchMode=yes"
    }

    options {
        timeout(time: 40, unit: 'MINUTES')
        timestamps()
        disableConcurrentBuilds()   // 共用一个远端目录,必须串行
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    stages {
        stage('连通性') {
            steps {
                sshagent(['dfzq-build-ssh']) {
                    sh 'ssh $SSH_OPTS $BUILD_HOST "hostname && uname -r && df -h /data | tail -1"'
                }
            }
        }

        stage('远端构建') {
            steps {
                // 把脚本**喂给**远端 bash,而不是拼进 ssh 的引号里 —— 避免嵌套引号地狱,
                // 也让构建逻辑跟代码一起版本管理(ci/remote-build.sh)。
                // GIT_COMMIT 由 Jenkins 的 SCM 检出提供:构建的是**这次触发的那个 commit**,
                // 不是远端 HEAD 恰好指到哪。
                sshagent(['dfzq-build-ssh']) {
                    sh '''
                        ssh $SSH_OPTS $BUILD_HOST \
                          "GIT_URL='$GIT_REPO' GIT_COMMIT='$GIT_COMMIT' REMOTE_DIR='$REMOTE_DIR' \
                           NODE_HOME='$NODE_HOME' NPM_REGISTRY='${NPM_REGISTRY:-}' bash -s" \
                          < ci/remote-build.sh
                    '''
                }
            }
        }

        stage('取回测试报告') {
            steps {
                sshagent(['dfzq-build-ssh']) {
                    sh '''
                        mkdir -p .ci
                        scp $SSH_OPTS $BUILD_HOST:$REMOTE_DIR/.ci/junit-*.xml .ci/
                        ls -l .ci/
                    '''
                }
            }
        }
    }

    post {
        always {
            junit allowEmptyResults: false, testResults: '.ci/junit-*.xml'
            archiveArtifacts artifacts: '.ci/junit-*.xml', allowEmptyArchive: true
        }
        failure {
            echo '构建失败 —— 看第一个红色 stage;常见成因见 README-内网Git与Jenkins.md §6'
        }
    }
}
