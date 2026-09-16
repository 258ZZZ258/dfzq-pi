from pathlib import Path
import importlib.util
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def test_packages_resolve_inside_embedded_service():
    for name in ["pipeline", "query", "common", "eval"]:
        spec = importlib.util.find_spec(name)
        assert spec is not None and Path(spec.origin).is_relative_to(ROOT)


def test_config_follows_service_location():
    from pipeline.config import DEFAULT_CONFIG_DIR
    assert DEFAULT_CONFIG_DIR == ROOT / "config"


def test_minimal_office_fixture_is_generated(preseg_fixture):
    assert not (ROOT / "pipeline/tests/fixtures/preseg_batch/manifest.xlsx").exists()
    assert (preseg_fixture / "manifest.xlsx").is_file()


def test_runner_check_is_offline_and_parseable():
    result = subprocess.run([sys.executable, str(ROOT / "service.py"), "check"], cwd=ROOT.parent.parent, capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["databaseTouched"] is False


def test_migration_sql_has_runtime_state_without_feedback():
    result = subprocess.run([sys.executable, str(ROOT / "service.py"), "migration-sql"], cwd=ROOT.parent.parent, capture_output=True, text=True, check=True)
    assert "CREATE TABLE IF NOT EXISTS agent_state" in result.stdout
    assert "principal_json" in result.stdout
    assert "feedback_rubric" not in result.stdout
