# Audit AI service

Python retrieval, document processing and shared database contracts embedded in the Pi repository. Imported from `dfzq-audit-ai` commit `38a2bd3cdd2484622b3a7529e3852e2d6c4e56fc`; the later feedback migration and optimization subsystem are excluded. `IMPORT-MANIFEST.json` records the original files and hashes; integration adaptations are described below.

```text
services/audit-ai/
  libs/common/       IR, database and retrieval contracts
  pipeline/          document processing and indexing
  query/             HTTP query API and policy MCP server
  eval/              pipeline verification utilities
  config/ seeds/     runtime configuration and dictionaries
  alembic/           database migration chain
  service.py         repository-relative command entry
```

## Install

Python 3.11+ is required. From the repository root:

```sh
python3 -m venv services/audit-ai/.venv
services/audit-ai/.venv/bin/python -m pip install -c services/audit-ai/constraints.txt \
  -e services/audit-ai/libs/common -e services/audit-ai/pipeline \
  -e services/audit-ai/query -e services/audit-ai/eval -e 'services/audit-ai[dev]'
```

Direct dependencies and build tools are pinned in the member `pyproject.toml` files. `constraints.txt` captures transitive versions from the validated runtime environment; it is a constraints file, not a request to install every optional backend. OCR/local embedding/observability extras are optional and not installed or model-downloaded by the commands below. Their direct versions are pinned, but their external services/model weights were not validated in this integration.

An existing interpreter may be selected with `DFZQ_AUDIT_AI_PYTHON`. Runtime source imports still come from this repository: `service.py` constructs the four member import roots and uses the service directory as cwd. No sibling audit-ai checkout is required.

## Commands

```sh
npm run audit-ai:check
npm run audit-ai:test
npm run audit-ai:mcp
npm run audit-ai:api -- --host 127.0.0.1 --port 8000
npm run audit-ai:migration-sql
```

`check` parses Python sources and validates pins without contacting a backend. `test` runs an explicit offline allowlist; real-stack tests are not implicitly enabled by the config directory. To select additional tests, pass pytest paths after `--`. Real Milvus scope-mirror tests additionally require `AUDIT_AI_INTEGRATION_TESTS=1` and an explicitly selected config. A skipped real-stack test is not a successful integration test.

`migration-sql` renders SQL offline; it does not apply it. The new `0018_runtime_reliability` migration follows `0017_task_runtime_history`, adds task actor/receipt/session-origin fields and CAS state, and widens session IDs to match the HTTP contract. The old self-optimization feedback revision is not included. Existing databases already stamped with a different `0018` revision need an operator-reviewed migration plan; do not restamp or downgrade them automatically.

## Configuration and isolation

- `PIPELINE_CONFIG_DIR` / `QUERY_CONFIG_DIR`: optional config roots; defaults resolve within this service.
- `PIPELINE_DB_DSN`, `PIPELINE_MILVUS_HOST`, dedicated embedding and rerank variables: configure actual backends explicitly. The checked-in compose stack and default credentials are local demo settings, not a production deployment.
- `POLICY_MCP_AUDIT_LOG`: required by the MCP entry. Pi supplies a runtime log path by default.
- `AUDIT_AI_TENANT_ID`: required when Pi sends a signed tenant scope. Each deployed service/database/index must belong to this one configured tenant; this is not row-level multi-tenant storage.
- Incoming non-null `project_id` or `owner` restrictions are rejected because the imported index does not implement these ACLs. They must never be silently ignored.
- Java still owns authentication/authorization decisions; Pi validates signed grants, Python applies supported `perm_tags` / corpus filters before retrieval. No private key or bearer token is stored here.

Only named service variables are forwarded to the policy MCP subprocess. The API remains available for existing consumers. No database, model, vector index or real document ingestion is started by `check` or the default tests.

## Import adaptations

- Excluded local agent/editor/CI configuration, product plans, private data and Office binaries.
- Converted the minimal two-record workbook fixture to JSON facts and generate XLSX in pytest temporary directories.
- Pinned dependencies; made Alembic paths relative to its config; added a unified command wrapper.
- Added strict tenant matching and fail-closed unsupported resource scopes at the MCP boundary.
- Added runtime reliability migration/ORM metadata and explicit gating of the real-stack mirror test.

Pi's native audit-report and supervision-analysis tasks retain their existing business behavior. Their mutable private draft/association state is not a Session checkpoint: `durableSession:false` keeps automatic resume and queued continuation disabled until a dedicated state contract exists. They still run through the common runtime, authorization checks, output validation and worker process isolation.
