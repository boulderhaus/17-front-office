BEGIN;

ALTER TABLE callback_tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_source text;

CREATE INDEX IF NOT EXISTS callback_tasks_tenant_updated_idx
  ON callback_tasks(tenant_id, updated_at DESC);

COMMIT;
