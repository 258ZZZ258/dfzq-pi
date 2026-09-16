CREATE TABLE IF NOT EXISTS agent_state (
  state_key TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision > 0),
  value_json JSONB NOT NULL
);
