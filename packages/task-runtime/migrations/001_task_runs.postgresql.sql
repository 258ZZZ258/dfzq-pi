-- Initial schema for src/store/postgres.ts. Apply once to an empty dedicated
-- database/schema before starting the service. Existing tables require review;
-- do not silently accept an incompatible schema with IF NOT EXISTS.
BEGIN;
CREATE TABLE task_runs (
  run_id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  request_id TEXT,
  spec_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  filters_json JSONB NOT NULL,
  options_json JSONB,
  payload_json JSONB,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error_message TEXT,
  stop_reason TEXT,
  limit_hit TEXT,
  usage_json JSONB,
  turns INTEGER,
  source_details_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX task_runs_session_created_idx ON task_runs (session_id, created_at);
CREATE INDEX task_runs_status_idx ON task_runs (status);
CREATE TABLE task_run_events (
  run_id TEXT NOT NULL REFERENCES task_runs(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);
COMMIT;
