-- Apply before deploying receipt-aware pi; no historical validation is inferred.
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS delivery_json JSONB;
