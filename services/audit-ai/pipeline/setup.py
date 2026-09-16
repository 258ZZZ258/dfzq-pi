"""条件注册 console_scripts —— 生产构建剔除人操作面入口(方案 A,预部署对齐)。

pyproject 声明 `dynamic = ["scripts"]`,实际入口在此按构建 profile 注入:

- 默认(dev):注册 `demo` / `demo-web`(CLI + Web 工作台),开发/运维照常。
- `PIPELINE_BUILD_PROFILE=production`(构建/安装期设):**不注册**任何 console_scripts,
  生产镜像无 CLI/TUI 入口(减小人操作面/攻击面;audit-ai 生产=Java 之后无身份·无状态端点)。

CLI/Web **代码保留**供 dev/运维;生产如确需临时 ops,仍可 `python -m pipeline.cli` /
`python -m pipeline.web.app`(见各自 `__main__`)。其余打包元数据全在 pyproject.toml。

构建示例:
    PIPELINE_BUILD_PROFILE=production pip wheel pipeline/ --no-deps   # 生产 wheel(无 demo/demo-web)
    pip install -e pipeline                                          # dev(含 demo/demo-web)
"""

import os

from setuptools import setup

_PROD = os.environ.get("PIPELINE_BUILD_PROFILE") == "production"
_console_scripts = (
    []
    if _PROD
    else [
        "demo = pipeline.cli:app",
        "demo-web = pipeline.web.app:main",
    ]
)

setup(entry_points={"console_scripts": _console_scripts})
