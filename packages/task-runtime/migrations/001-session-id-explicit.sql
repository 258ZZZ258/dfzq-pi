-- Apply to the task-history database before deploying the updated runtime.
-- Leave legacy rows NULL: the original request's field presence is unknown.
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS session_id_explicit BOOLEAN;
