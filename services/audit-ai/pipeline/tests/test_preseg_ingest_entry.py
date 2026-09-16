"""预切块生产摄取入口 ``python -m pipeline.preseg_ingest`` 的接线单元(零栈,monkeypatch)。

只验入口把 register_preseg_batch + _drive_batch 正确接在一起(批次 id 一致、拒收即止、缺目录报错);
端到端 REGISTERED→INDEXED 由模型门集成测 ``test_preseg_e2e`` 覆盖,不在此重复。
"""

from __future__ import annotations

from collections import Counter

import pytest

from pipeline import preseg_ingest as pi


class _FakeReport:
    def __init__(self, accepted: bool = True, reject_reason: str = "") -> None:
        self.accepted = accepted
        self.reject_reason = reject_reason
        self.warnings: list[str] = []

    def counts(self) -> Counter:
        return Counter({"REGISTERED": 1})


class _FakeSession:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def scalars(self, *a, **k):
        return []


class _FakePg:
    def session(self):
        return _FakeSession()


def _patch_context(monkeypatch):
    monkeypatch.setattr(pi, "_drive_context", lambda cfg: (_FakePg(), object()))
    # 批末对账是独立集成关注点(见 test_preseg_cases_ingest);接线单元 no-op 掉
    monkeypatch.setattr(pi, "reconcile_preseg_case_refs", lambda ctx, bid: 0)


def test_run_wires_register_then_drive_same_batch_id(monkeypatch):
    _patch_context(monkeypatch)
    seen: dict = {}

    def fake_register(ctx, bid, bdir, mpath):
        seen["register"] = (bid, bdir, mpath)
        return _FakeReport(accepted=True)

    def fake_drive(pg, ctx, bid):
        seen["drive_bid"] = bid
        return 5

    monkeypatch.setattr(pi, "register_preseg_batch", fake_register)
    monkeypatch.setattr(pi, "_drive_batch", fake_drive)

    from pathlib import Path

    rc = pi.run(Path("/some/batch"), batch_id="B1")
    assert rc == 0
    # 默认 manifest = <batch_dir>/manifest.xlsx;驱动用登记的同一 batch_id
    assert seen["register"] == ("B1", Path("/some/batch"), Path("/some/batch/manifest.xlsx"))
    assert seen["drive_bid"] == "B1"


def test_run_generates_batch_id_when_omitted(monkeypatch):
    _patch_context(monkeypatch)
    seen: dict = {}

    def fake_register(ctx, bid, bdir, mpath):
        seen["bid"] = bid
        return _FakeReport(accepted=True)

    def fake_drive(pg, ctx, bid):
        seen["drive"] = bid
        return 0

    monkeypatch.setattr(pi, "register_preseg_batch", fake_register)
    monkeypatch.setattr(pi, "_drive_batch", fake_drive)

    from pathlib import Path

    pi.run(Path("/b"))
    assert seen["bid"] and seen["bid"] == seen["drive"]  # 自动生成的 id 贯穿登记与驱动


def test_run_rejected_batch_skips_drive(monkeypatch):
    _patch_context(monkeypatch)
    monkeypatch.setattr(
        pi, "register_preseg_batch",
        lambda *a, **k: _FakeReport(accepted=False, reject_reason="manifest 列不匹配"),
    )
    called = {"drive": False}
    monkeypatch.setattr(pi, "_drive_batch", lambda *a, **k: called.__setitem__("drive", True))

    from pathlib import Path

    rc = pi.run(Path("/b"))
    assert rc == 1 and called["drive"] is False  # 拒收即止,不驱动


def test_main_uses_manifest_option(monkeypatch):
    _patch_context(monkeypatch)
    seen: dict = {}

    def fake_register(ctx, bid, bdir, mpath):
        seen["mpath"] = mpath
        return _FakeReport(accepted=True)

    monkeypatch.setattr(pi, "register_preseg_batch", fake_register)
    monkeypatch.setattr(pi, "_drive_batch", lambda *a, **k: 0)
    # 目录存在校验:让 batch_dir 指向真实 tmp,manifest 指向别处
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        rc = pi.main([d, "-m", "/custom/mf.xlsx"])
    assert rc == 0 and seen["mpath"] == Path("/custom/mf.xlsx")


def test_main_rejects_missing_dir():
    with pytest.raises(SystemExit):
        pi.main(["/no/such/batch/dir/xyz"])
