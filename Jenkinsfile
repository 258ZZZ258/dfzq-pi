// dfzq-pi 内网 CI —— Jenkins Pipeline
//
// 形态:主节点没有合适版本的 Node,不跑构建,也不建独立 agent 节点。
//      主节点负责:检出代码(Pipeline script from SCM 本来就会做)→ rsync 到构建机
//                 → SSH 触发构建 → 取回测试报告
//      构建机(pi 运行的那台 Linux)负责:装依赖、检查、跑测试。
//
// 🔴 代码由主节点 rsync 过去,**构建机不需要 Git 访问、不需要 Git 凭证** ——
//    凭证只留在主节点一处;也避免了非交互 SSH 会话里 git clone 撞认证那类问题。
//
// 前置:
//   插件:Credentials Binding(Jenkins 建议插件之一,通常自带)
//         —— 刻意**不用** SSH Agent 插件:内网 Jenkins 连不上更新站、装不了插件。
//   凭证:"SSH Username with private key",ID = dfzq-build-ssh
//   全局环境变量:DFZQ_BUILD_HOST 必需;
//                DFZQ_NODE_HOME / NPM_REGISTRY / DFZQ_BUILD_DIR 可选
//   两端都要有 rsync(构建机上有;主节点没有的话见 README 的退路)

pipeline {
    agent any

    environment {
        BUILD_HOST = "${env.DFZQ_BUILD_HOST}"
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
                withCredentials([sshUserPrivateKey(credentialsId: 'dfzq-build-ssh', keyFileVariable: 'SSH_KEY')]) {
                    sh 'ssh -i $SSH_KEY $SSH_OPTS $BUILD_HOST "hostname && uname -r && df -h /data | tail -1"'
                }
            }
        }

        stage('同步代码到构建机') {
            steps {
                // 留一份版本留痕,构建日志里能看到这次构建的到底是哪一版
                sh '''
                    mkdir -p .ci
                    printf 'commit=%s\\nbranch=%s\\nbuild=%s\\n' \
                        "${GIT_COMMIT:-unknown}" "${GIT_BRANCH:-unknown}" "${BUILD_TAG:-unknown}" \
                        > .ci/BUILD_INFO
                    cat .ci/BUILD_INFO
                '''
                withCredentials([sshUserPrivateKey(credentialsId: 'dfzq-build-ssh', keyFileVariable: 'SSH_KEY')]) {
                    // --delete:删掉远端的陈旧文件(等价于旧设计里的 git clean)
                    // --exclude node_modules:既不传也**不删** —— 复用远端已装的依赖,重装一次要几分钟
                    // --exclude .git:构建用不到,省 58M 之外的传输
                    sh '''
                        ssh -i $SSH_KEY $SSH_OPTS $BUILD_HOST "mkdir -p $REMOTE_DIR"
                        rsync -az --delete \
                              --exclude='node_modules' --exclude='.git' \
                              -e "ssh -i $SSH_KEY $SSH_OPTS" \
                              ./ $BUILD_HOST:$REMOTE_DIR/
                    '''
                }
            }
        }

        stage('远端构建') {
            steps {
                // 把脚本喂给远端 bash,而不是拼进 ssh 的引号里 —— 避免嵌套引号地狱,
                // 也让 ci/remote-build.sh 能在构建机上单独手工跑一遍排障。
                withCredentials([sshUserPrivateKey(credentialsId: 'dfzq-build-ssh', keyFileVariable: 'SSH_KEY')]) {
                    sh '''
                        ssh -i $SSH_KEY $SSH_OPTS $BUILD_HOST \
                          "REMOTE_DIR='$REMOTE_DIR' NODE_HOME='$NODE_HOME' \
                           NPM_REGISTRY='${NPM_REGISTRY:-}' bash -s" \
                          < ci/remote-build.sh
                    '''
                }
            }
        }

        stage('取回测试报告') {
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'dfzq-build-ssh', keyFileVariable: 'SSH_KEY')]) {
                    sh '''
                        mkdir -p .ci
                        scp -i $SSH_KEY $SSH_OPTS $BUILD_HOST:$REMOTE_DIR/.ci/junit-*.xml .ci/
                        ls -l .ci/
                    '''
                }
            }
        }
    }

    post {
        always {
            // allowEmptyResults:false —— 没有测试报告本身就该是红的,
            // 否则「测试其实没跑到」会伪装成绿色构建。
            junit allowEmptyResults: false, testResults: '.ci/junit-*.xml'
            archiveArtifacts artifacts: '.ci/junit-*.xml,.ci/BUILD_INFO', allowEmptyArchive: true
        }
        failure {
            echo '构建失败 —— 看第一个红色 stage;常见成因见 README-内网Git与Jenkins.md §6'
        }
    }
}
