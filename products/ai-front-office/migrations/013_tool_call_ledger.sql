BEGIN;

-- Voice tool budgets and write results, shared by every replica and kept across restarts.
-- A phone call lasts minutes, so the retention loop drops rows untouched for two hours.
CREATE TABLE IF NOT EXISTS tool_call_budgets (
  provider_call_id text NOT NULL,
  tool text NOT NULL,
  call_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_call_id, tool)
);
CREATE INDEX IF NOT EXISTS tool_call_budgets_updated_at_idx ON tool_call_budgets(updated_at);

-- Idempotency for book_slot and save_intake: a late or repeated write returns the first result.
-- Results hold statuses and instructions only, never caller details.
CREATE TABLE IF NOT EXISTS tool_results (
  idempotency_key text PRIMARY KEY,
  provider_call_id text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_results_created_at_idx ON tool_results(created_at);

COMMIT;
