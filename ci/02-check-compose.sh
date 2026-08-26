#!/usr/bin/env bash
# 02-check-compose.sh —— compose 键白名单静态检查(按 docker-compose 1.29.2 的 schema)。
#
# 🔴 这是「compose 文件在生产的 1.29.2 上能不能解析」的防线之一:排练栈跑在主节点,
#    若主节点 compose 版本更新,1.29.2 的解析限制不被排练覆盖 —— 现场撞过的顶层
#    `name:` 键那类问题只有这里拦得住。白名单出处:1.29.2 真二进制的 compose_spec.json
#    (与 ~/dfzq-predeploy/tests/test-stack.sh Part 6 同一份)。
#
# 🔴 在**底座容器里**跑,不在宿主上跑:check-compose-keys.sh 要 python3,而主节点
#    没有(RHEL 7.4,2026-08-26 首跑实测翻红)。底座里有 python3 —— 宿主只要有 Docker。
#    :ro,z —— 只读挂载;z 兼容 SELinux enforcing 的宿主,disabled 时是空操作。
source "$(dirname "$0")/lib.sh"
require_base_tag

IMG="${REGISTRY}/dfzq-pi-base:${BASE_TAG}"
docker image inspect "$IMG" >/dev/null 2>&1 || docker pull "$IMG"
docker run --rm -v "$PWD":/w:ro,z -w /w --entrypoint bash "$IMG" deploy/check-compose-keys.sh
