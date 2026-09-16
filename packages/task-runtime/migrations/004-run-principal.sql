-- Java grant principal is independent of memory configuration. Legacy NULL stays unowned.
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS principal_json JSONB;
