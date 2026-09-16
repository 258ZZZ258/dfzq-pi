"""Repository-relative entry point. No command implicitly installs or migrates a database."""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parent
IMPORT_ROOTS = [ROOT / "libs/common", ROOT / "pipeline", ROOT / "query", ROOT / "eval"]
TESTS = [
    "query/tests/mcp/test_scope.py",
    "query/tests/mcp/test_session.py", "query/tests/mcp/test_search_policy.py",
    "query/tests/mcp/test_get_clause_detail.py", "query/tests/mcp/test_server_startup.py",
    "pipeline/tests/test_preseg_reader.py", "query/tests/test_query_config.py",
    "tests/test_monorepo.py", "tests/test_tenant_scope.py",
]


def check() -> None:
    parsed = 0
    for folder in [ROOT / "libs", ROOT / "pipeline", ROOT / "query", ROOT / "eval", ROOT / "alembic"]:
        for file in folder.rglob("*.py"):
            if "__pycache__" not in file.parts:
                ast.parse(file.read_text(encoding="utf-8"), filename=str(file.relative_to(ROOT)))
                parsed += 1
    for relative in ["pyproject.toml", "libs/common/pyproject.toml", "pipeline/pyproject.toml", "query/pyproject.toml", "eval/pyproject.toml"]:
        spec = tomllib.loads((ROOT / relative).read_text())
        requirements = spec["build-system"]["requires"] + spec["project"].get("dependencies", [])
        requirements += [value for group in spec["project"].get("optional-dependencies", {}).values() for value in group]
        if any("==" not in requirement or "*" in requirement for requirement in requirements):
            raise RuntimeError(f"unpinned dependency in {relative}")
    if any((ROOT / "alembic/versions").glob("*feedback*")):
        raise RuntimeError("self-optimization migration is outside this release")
    print(json.dumps({"service": "audit-ai", "pythonFilesParsed": parsed, "dependencies": "pinned", "config": "repository-relative", "databaseTouched": False}))


def main() -> int:
    command, *args = sys.argv[1:] or ["check"]
    os.chdir(ROOT)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": os.pathsep.join(str(path) for path in IMPORT_ROOTS)}
    if command == "test" and env.get("AUDIT_AI_INTEGRATION_TESTS") != "1":
        # Config-path presence enables legacy real-stack fixtures; do not enable them
        # merely because this launcher knows the service's default config directory.
        for key in ["PIPELINE_CONFIG_DIR", "QUERY_CONFIG_DIR", "PIPELINE_DB_DSN", "PIPELINE_MILVUS_HOST", "OPENAI_BASE_URL", "OPENAI_API_KEY"]:
            env.pop(key, None)
    commands = {
        "test": ["-m", "pytest", "-q", *(args or TESTS)],
        "mcp": ["-m", "query.mcp.server", *args],
        "api": ["-m", "uvicorn", "query.api.app:app", *args],
        "migration-sql": ["-m", "alembic", "-c", str(ROOT / "alembic.ini"), "upgrade", "head", "--sql"],
    }
    if command == "check":
        check()
        return 0
    if command not in commands:
        raise SystemExit("usage: service.py check|test|mcp|api|migration-sql")
    if command in {"mcp", "api"}:
        os.execve(sys.executable, [sys.executable, *commands[command]], env)
    return subprocess.call([sys.executable, *commands[command]], env=env)


if __name__ == "__main__":
    raise SystemExit(main())
