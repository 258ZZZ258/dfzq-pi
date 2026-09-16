import pytest

from query.mcp.scope import ScopeError, parse_auth


def arguments(**changes):
    return {"perm_tags": ["d1"], "corpus_types": ["internal"], "run_id": "r", "tenant_id": "t1", "user_id": "u1", "project_id": None, "owner": None, **changes}


def test_strict_scope_requires_configured_tenant(monkeypatch):
    monkeypatch.delenv("AUDIT_AI_TENANT_ID", raising=False)
    with pytest.raises(ScopeError, match="tenant"):
        parse_auth(arguments())
    monkeypatch.setenv("AUDIT_AI_TENANT_ID", "t1")
    assert parse_auth(arguments()).tenant_id == "t1"
    with pytest.raises(ScopeError, match="tenant"):
        parse_auth(arguments(tenant_id="t2"))


@pytest.mark.parametrize("field", ["project_id", "owner"])
def test_unsupported_resource_restriction_cannot_be_silently_ignored(monkeypatch, field):
    monkeypatch.setenv("AUDIT_AI_TENANT_ID", "t1")
    with pytest.raises(ScopeError, match="unsupported authorization restriction"):
        parse_auth(arguments(**{field: "restricted"}))


@pytest.mark.parametrize("field", ["project_id", "owner"])
def test_legacy_scope_also_rejects_unsupported_restrictions(field):
    with pytest.raises(ScopeError, match="unsupported authorization restriction"):
        parse_auth({"perm_tags": ["d1"], "corpus_types": ["internal"], "run_id": "r", field: "restricted"})
